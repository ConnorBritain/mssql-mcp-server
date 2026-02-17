#!/usr/bin/env node

// External imports
import { Buffer } from "node:buffer";
import * as dotenv from "dotenv";
import sql from "mssql";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// Node 21+ dropped the legacy global SlowBuffer. Some transitive deps (jsonwebtoken)
// still reference it, so reintroduce a shim to keep compatibility with latest Node.
if (!(globalThis as any).SlowBuffer) {
  (globalThis as any).SlowBuffer = Buffer.allocUnsafeSlow;
}

dotenv.config();

// Internal imports
import { UpdateDataTool } from "./tools/UpdateDataTool.js";
import { InsertDataTool } from "./tools/InsertDataTool.js";
import { ReadDataTool } from "./tools/ReadDataTool.js";
import { CreateTableTool } from "./tools/CreateTableTool.js";
import { CreateIndexTool } from "./tools/CreateIndexTool.js";
import { ListTableTool } from "./tools/ListTableTool.js";
import { DropTableTool } from "./tools/DropTableTool.js";
import { TestConnectionTool } from "./tools/TestConnectionTool.js";
import { DeleteDataTool } from "./tools/DeleteDataTool.js";
import { DefaultAzureCredential, InteractiveBrowserCredential } from "@azure/identity";
import { DescribeTableTool } from "./tools/DescribeTableTool.js";
import { SearchSchemaTool } from "./tools/SearchSchemaTool.js";
import { ProfileTableTool } from "./tools/ProfileTableTool.js";
import { RelationshipInspectorTool } from "./tools/RelationshipInspectorTool.js";
import { ExplainQueryTool } from "./tools/ExplainQueryTool.js";
import { ListDatabasesTool } from "./tools/ListDatabasesTool.js";
import { ListEnvironmentsTool } from "./tools/ListEnvironmentsTool.js";
import { ValidateEnvironmentConfigTool } from "./tools/ValidateEnvironmentConfigTool.js";
import { ListScriptsTool } from "./tools/ListScriptsTool.js";
import { RunScriptTool } from "./tools/RunScriptTool.js";
import { InspectDependenciesTool } from "./tools/InspectDependenciesTool.js";
import { auditLogger } from "./audit/AuditLogger.js";
import { getEnvironmentManager } from "./config/EnvironmentManager.js";
import { initScriptManager } from "./config/ScriptManager.js";
import * as crypto from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const SERVER_VERSION: string = (require("../package.json") as any).version ?? "unknown";

// Generate a unique session ID for this server instance
// This allows correlation of all tool invocations within a single MCP session
const SESSION_ID = crypto.randomUUID();

// ─────────────────────────────────────────────────────────────────────────────
// Intent Routing (internal, not exposed as a tool)
// ─────────────────────────────────────────────────────────────────────────────

type IntentCategory =
  | "data_read"
  | "data_write"
  | "schema_discovery"
  | "schema_change"
  | "metadata";

interface RunnableTool extends Tool {
  run: (args: any) => Promise<any>;
}

interface ToolRoutingConfig {
  tool: RunnableTool;
  name: string;
  intents: IntentCategory[];
  keywords?: string[];
  requiredArgs?: string[];
  mutatesData?: boolean;
  schemaChange?: boolean;
  baseScore?: number;
  requiresConfirmation?: boolean;
}

interface IntentRouterOptions {
  tools: ToolRoutingConfig[];
  allowMutations: boolean;
  requireConfirmationForMutations: boolean;
}

interface RoutingCandidate {
  config: ToolRoutingConfig;
  score: number;
  reasons: string[];
}

interface RouteParams {
  prompt: string;
  toolArguments?: Record<string, any>;
  confirmIntent?: boolean;
  preferredToolName?: string;
  environment?: string;
}

interface RouteResult {
  success: boolean;
  routedTool?: string;
  intent?: IntentCategory;
  reasoning?: string[];
  toolResult?: any;
  message?: string;
  error?: string;
  selectedEnvironment?: string;
}

class IntentRouter {
  private readonly tools: ToolRoutingConfig[];
  private readonly allowMutations: boolean;
  private readonly requireConfirmationForMutations: boolean;

  constructor(options: IntentRouterOptions) {
    this.tools = options.tools;
    this.allowMutations = options.allowMutations;
    this.requireConfirmationForMutations = options.requireConfirmationForMutations;
  }

  async route(params: RouteParams): Promise<RouteResult> {
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (!prompt) {
      return {
        success: false,
        message: "Prompt is required to route intent.",
        error: "MISSING_PROMPT",
      };
    }

    const toolArguments = this.normalizeArguments(params.toolArguments ?? {});
    const confirmIntent = Boolean(params.confirmIntent);
    const preferredToolName = params.preferredToolName;
    const normalizedPrompt = prompt.toLowerCase();

    // Infer environment from prompt if not explicitly provided
    const environment = params.environment || this.inferEnvironment(normalizedPrompt);
    if (environment) {
      toolArguments.environment = environment;
    }

    const inferredIntent = this.inferIntent(normalizedPrompt, toolArguments);
    const eligibleTools = this.tools.filter((tool) => this.isToolEligible(tool));

    const candidates = eligibleTools
      .map((tool) =>
        this.scoreTool(tool, normalizedPrompt, toolArguments, inferredIntent, preferredToolName)
      )
      .filter((candidate): candidate is RoutingCandidate => candidate.score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => b.score - a.score);

    const bestCandidate = candidates[0];
    if (!bestCandidate || bestCandidate.score <= 0) {
      return {
        success: false,
        message:
          "Unable to determine an appropriate SQL tool for the provided prompt. Try specifying the desired action more concretely (e.g., 'list tables', 'describe table X', 'run SELECT ...').",
        error: "NO_TOOL_MATCH",
      };
    }

    const missingArgs = this.getMissingArguments(bestCandidate.config, toolArguments);
    if (missingArgs.length) {
      return {
        success: false,
        routedTool: bestCandidate.config.name,
        message: `Selected tool '${bestCandidate.config.name}' requires argument(s): ${missingArgs.join(", ")}. Provide them in the request arguments.`,
        error: "MISSING_ARGUMENTS",
      };
    }

    const requiresConfirmation =
      (bestCandidate.config.requiresConfirmation ||
        bestCandidate.config.mutatesData ||
        bestCandidate.config.schemaChange) &&
      this.requireConfirmationForMutations;

    if (requiresConfirmation && !confirmIntent) {
      return {
        success: false,
        routedTool: bestCandidate.config.name,
        message:
          "This operation modifies data or schema. Re-run with confirmIntent: true to proceed.",
        error: "CONFIRMATION_REQUIRED",
      };
    }

    try {
      const result = await bestCandidate.config.tool.run(toolArguments);
      return {
        success: true,
        routedTool: bestCandidate.config.name,
        intent: inferredIntent,
        reasoning: bestCandidate.reasons,
        toolResult: result,
        selectedEnvironment: environment,
      };
    } catch (error) {
      return {
        success: false,
        routedTool: bestCandidate.config.name,
        message: `Routed tool '${bestCandidate.config.name}' failed: ${error}`,
        error: "ROUTED_TOOL_FAILED",
        selectedEnvironment: environment,
      };
    }
  }

  private inferEnvironment(prompt: string): string | undefined {
    // Get available environments from the manager
    const envManager = getEnvironmentManager();
    const environments = envManager.listEnvironments();

    // Look for exact environment name mentions
    for (const env of environments) {
      const patterns = [
        new RegExp(`\\b${env.name}\\b`, "i"),
        new RegExp(`\\b${env.name.replace(/-/g, "\\s")}\\b`, "i"), // Handle dashes as spaces
      ];

      for (const pattern of patterns) {
        if (pattern.test(prompt)) {
          return env.name;
        }
      }
    }

    // Look for common environment keywords
    const envKeywords: Record<string, string[]> = {
      prod: ["production", "prod", "live"],
      staging: ["staging", "stage", "uat"],
      dev: ["development", "dev", "local"],
    };

    for (const [envSuffix, keywords] of Object.entries(envKeywords)) {
      for (const keyword of keywords) {
        if (prompt.includes(keyword)) {
          // Try to find an environment with this suffix
          const matchingEnv = environments.find((e) =>
            e.name.toLowerCase().includes(envSuffix)
          );
          if (matchingEnv) {
            return matchingEnv.name;
          }
        }
      }
    }

    // No environment inferred, will use default
    return undefined;
  }

  private normalizeArguments(args: any) {
    if (!args || typeof args !== "object") {
      return {};
    }
    const cloned: Record<string, any> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) {
        cloned[key] = value;
      }
    }
    return cloned;
  }

  private isToolEligible(tool: ToolRoutingConfig) {
    if (this.allowMutations) {
      return true;
    }
    return !tool.mutatesData && !tool.schemaChange;
  }

  private inferIntent(prompt: string, toolArguments: Record<string, any>): IntentCategory {
    const detectors: Array<{ intent: IntentCategory; keywords: string[] }> = [
      {
        intent: "schema_change",
        keywords: ["create table", "drop table", "create index", "drop index", "alter", "ddl"],
      },
      {
        intent: "data_write",
        keywords: ["update", "insert", "delete", "fix", "modify", "change", "correct"],
      },
      {
        intent: "metadata",
        keywords: ["profile", "sample", "statistics", "distribution", "quality"],
      },
      {
        intent: "schema_discovery",
        keywords: ["describe", "columns", "list tables", "show tables", "schema", "search"],
      },
      {
        intent: "data_read",
        keywords: ["select", "query", "fetch", "count", "report", "view"],
      },
    ];

    for (const detector of detectors) {
      if (detector.keywords.some((keyword) => prompt.includes(keyword))) {
        return detector.intent;
      }
    }

    const sqlSnippet = this.extractSqlSnippet(toolArguments);
    if (sqlSnippet) {
      if (sqlSnippet.startsWith("select")) {
        return "data_read";
      }
      if (sqlSnippet.startsWith("update") || sqlSnippet.startsWith("delete")) {
        return "data_write";
      }
      if (sqlSnippet.startsWith("insert")) {
        return "data_write";
      }
      if (sqlSnippet.startsWith("create") || sqlSnippet.startsWith("drop")) {
        return "schema_change";
      }
    }

    if (toolArguments?.tablePattern || toolArguments?.columnPattern) {
      return "schema_discovery";
    }

    return "data_read";
  }

  private extractSqlSnippet(args: Record<string, any>) {
    const sqlCandidate =
      typeof args?.query === "string" ? args.query : typeof args?.sql === "string" ? args.sql : null;
    return sqlCandidate?.trim().toLowerCase() ?? null;
  }

  private scoreTool(
    config: ToolRoutingConfig,
    prompt: string,
    toolArguments: Record<string, any>,
    inferredIntent: IntentCategory,
    preferredToolName?: string
  ): RoutingCandidate {
    let score = config.baseScore ?? 0.5;
    const reasons: string[] = [];

    if (config.intents.includes(inferredIntent)) {
      score += 5;
      reasons.push(`intent match (${inferredIntent})`);
    }

    if (preferredToolName && config.name === preferredToolName) {
      score += 3;
      reasons.push("preferred tool match");
    }

    if (config.keywords?.length) {
      for (const keyword of config.keywords) {
        if (prompt.includes(keyword)) {
          score += 2;
          reasons.push(`keyword '${keyword}'`);
        }
      }
    }

    if (config.requiredArgs?.length) {
      for (const arg of config.requiredArgs) {
        if (this.hasArgument(toolArguments, arg)) {
          score += 1;
        } else {
          score -= 1;
        }
      }
    }

    if ((config.mutatesData || config.schemaChange) && !this.allowMutations) {
      score = Number.NEGATIVE_INFINITY;
    }

    return { config, score, reasons };
  }

  private hasArgument(args: Record<string, any>, key: string) {
    if (!args) {
      return false;
    }
    const value = args[key];
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return true;
  }

  private getMissingArguments(config: ToolRoutingConfig, args: Record<string, any>) {
    if (!config.requiredArgs || config.requiredArgs.length === 0) {
      return [];
    }
    return config.requiredArgs.filter((arg) => !this.hasArgument(args, arg));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Initialize environment manager
const environmentManager = getEnvironmentManager();

const updateDataTool = new UpdateDataTool();
const insertDataTool = new InsertDataTool();
const deleteDataTool = new DeleteDataTool();
const readDataTool = new ReadDataTool();
const createTableTool = new CreateTableTool();
const createIndexTool = new CreateIndexTool();
const listTableTool = new ListTableTool();
const listDatabasesTool = new ListDatabasesTool();
const listEnvironmentsTool = new ListEnvironmentsTool();
const validateEnvironmentConfigTool = new ValidateEnvironmentConfigTool();
const listScriptsTool = new ListScriptsTool();
const runScriptTool = new RunScriptTool();
const inspectDependenciesTool = new InspectDependenciesTool();
const dropTableTool = new DropTableTool();
const describeTableTool = new DescribeTableTool();
const searchSchemaTool = new SearchSchemaTool();
const profileTableTool = new ProfileTableTool();
const relationshipInspectorTool = new RelationshipInspectorTool();
const testConnectionTool = new TestConnectionTool();
const explainQueryTool = new ExplainQueryTool();

const MUTATING_TOOL_NAMES = new Set([
  "insert_data",
  "delete_data",
  "update_data",
  "create_table",
  "create_index",
  "drop_table",
]);

const toolRegistry: ToolRoutingConfig[] = [
  {
    tool: readDataTool,
    name: readDataTool.name,
    intents: ["data_read"],
    keywords: ["select", "query", "fetch", "report", "count"],
    requiredArgs: ["query"],
    baseScore: 2,
  },
  {
    tool: listTableTool,
    name: listTableTool.name,
    intents: ["schema_discovery"],
    keywords: ["list tables", "show tables", "tables"],
    baseScore: 1.5,
  },
  {
    tool: describeTableTool,
    name: describeTableTool.name,
    intents: ["schema_discovery"],
    keywords: ["describe", "columns", "structure"],
    requiredArgs: ["tableName"],
    baseScore: 1.5,
  },
  {
    tool: searchSchemaTool,
    name: searchSchemaTool.name,
    intents: ["schema_discovery"],
    keywords: ["search", "find", "look up"],
    baseScore: 1.5,
  },
  {
    tool: profileTableTool,
    name: profileTableTool.name,
    intents: ["metadata"],
    keywords: ["profile", "sample", "distribution"],
    requiredArgs: ["tableName"],
  },
  {
    tool: relationshipInspectorTool,
    name: relationshipInspectorTool.name,
    intents: ["metadata", "schema_discovery"],
    keywords: ["relationships", "foreign key", "references"],
    requiredArgs: ["tableName"],
  },
  {
    tool: insertDataTool,
    name: insertDataTool.name,
    intents: ["data_write"],
    keywords: ["insert", "add", "create record"],
    requiredArgs: ["tableName", "data"],
    mutatesData: true,
  },
  {
    tool: deleteDataTool,
    name: deleteDataTool.name,
    intents: ["data_write"],
    keywords: ["delete", "remove", "purge"],
    requiredArgs: ["tableName", "whereClause"],
    mutatesData: true,
  },
  {
    tool: updateDataTool,
    name: updateDataTool.name,
    intents: ["data_write"],
    keywords: ["update", "modify", "fix"],
    requiredArgs: ["tableName", "updates", "whereClause"],
    mutatesData: true,
  },
  {
    tool: createTableTool,
    name: createTableTool.name,
    intents: ["schema_change"],
    keywords: ["create table", "new table"],
    requiredArgs: ["tableName", "columns"],
    schemaChange: true,
  },
  {
    tool: createIndexTool,
    name: createIndexTool.name,
    intents: ["schema_change"],
    keywords: ["create index", "add index"],
    requiredArgs: ["tableName", "columns", "indexName"],
    schemaChange: true,
  },
  {
    tool: dropTableTool,
    name: dropTableTool.name,
    intents: ["schema_change"],
    keywords: ["drop table", "remove table", "delete table"],
    requiredArgs: ["tableName"],
    schemaChange: true,
    mutatesData: true,
  },
  {
    tool: testConnectionTool,
    name: testConnectionTool.name,
    intents: ["metadata"],
    keywords: ["test", "connection", "ping", "health"],
    baseScore: 1,
  },
  {
    tool: explainQueryTool,
    name: explainQueryTool.name,
    intents: ["metadata"],
    keywords: ["plan", "explain", "showplan", "estimate"],
    requiredArgs: ["query"],
    baseScore: 1,
  },
  {
    tool: listDatabasesTool,
    name: listDatabasesTool.name,
    intents: ["schema_discovery", "metadata"],
    keywords: ["databases", "list databases", "show databases", "dbs"],
    baseScore: 1.5,
  },
  {
    tool: listEnvironmentsTool,
    name: listEnvironmentsTool.name,
    intents: ["metadata"],
    keywords: ["environments", "list environments", "connections", "configs"],
    baseScore: 1.5,
  },
  {
    tool: validateEnvironmentConfigTool,
    name: validateEnvironmentConfigTool.name,
    intents: ["metadata"],
    keywords: ["validate", "check", "config", "configuration", "health"],
    baseScore: 1.5,
  },
  {
    tool: listScriptsTool,
    name: listScriptsTool.name,
    intents: ["metadata"],
    keywords: ["scripts", "list scripts", "templates", "named scripts"],
    baseScore: 1.5,
  },
  {
    tool: runScriptTool,
    name: runScriptTool.name,
    intents: ["data_read", "data_write"],
    keywords: ["run script", "execute script", "template"],
    requiredArgs: ["scriptName"],
    baseScore: 1.5,
  },
  {
    tool: inspectDependenciesTool,
    name: inspectDependenciesTool.name,
    intents: ["schema_discovery", "metadata"],
    keywords: ["dependencies", "depends", "references", "impact", "what uses"],
    requiredArgs: ["objectName"],
    baseScore: 1.5,
  },
];

const server = new Server(
  {
    name: "mssql-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Read READONLY env variable
const isReadOnly = process.env.READONLY === "true";
const requireMutationConfirmation = process.env.REQUIRE_MUTATION_CONFIRMATION !== "false";

const intentRouter = new IntentRouter({
  tools: toolRegistry,
  allowMutations: !isReadOnly,
  requireConfirmationForMutations: requireMutationConfirmation,
});

const readOnlyToolList = [
  listTableTool,
  listEnvironmentsTool,
  validateEnvironmentConfigTool,
  listScriptsTool,
  readDataTool,
  describeTableTool,
  searchSchemaTool,
  profileTableTool,
  relationshipInspectorTool,
  inspectDependenciesTool,
  testConnectionTool,
  explainQueryTool,
];

const fullToolList = [
  insertDataTool,
  deleteDataTool,
  readDataTool,
  describeTableTool,
  updateDataTool,
  createTableTool,
  createIndexTool,
  dropTableTool,
  listTableTool,
  listDatabasesTool,
  listEnvironmentsTool,
  validateEnvironmentConfigTool,
  listScriptsTool,
  runScriptTool,
  searchSchemaTool,
  profileTableTool,
  relationshipInspectorTool,
  inspectDependenciesTool,
  testConnectionTool,
  explainQueryTool,
];

const exposedTools = isReadOnly ? readOnlyToolList : fullToolList;

// Request handlers
// ... (rest of the code remains the same)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: exposedTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case insertDataTool.name:
        result = await insertDataTool.run(args);
        break;
      case deleteDataTool.name:
        result = await deleteDataTool.run(args);
        break;
      case readDataTool.name:
        result = await readDataTool.run(args);
        break;
      case updateDataTool.name:
        result = await updateDataTool.run(args);
        break;
      case createTableTool.name:
        result = await createTableTool.run(args);
        break;
      case createIndexTool.name:
        result = await createIndexTool.run(args);
        break;
      case listTableTool.name:
        result = await listTableTool.run(args);
        break;
      case listDatabasesTool.name:
        result = await listDatabasesTool.run(args);
        break;
      case listEnvironmentsTool.name:
        result = await listEnvironmentsTool.run(args);
        break;
      case validateEnvironmentConfigTool.name:
        result = await validateEnvironmentConfigTool.run(args as any);
        break;
      case listScriptsTool.name:
        result = await listScriptsTool.run(args as any);
        break;
      case runScriptTool.name:
        result = await runScriptTool.run(args as any);
        break;
      case inspectDependenciesTool.name:
        result = await inspectDependenciesTool.run(args as any);
        break;
      case dropTableTool.name:
        result = await dropTableTool.run(args);
        break;
      case testConnectionTool.name:
        result = await testConnectionTool.run(args);
        break;
      case explainQueryTool.name:
        result = await explainQueryTool.run(args);
        break;
      case describeTableTool.name:
        if (!args || typeof args.tableName !== "string") {
          return {
            content: [{ type: "text", text: `Missing or invalid 'tableName' argument for describe_table tool.` }],
            isError: true,
          };
        }
        result = await describeTableTool.run(args as { tableName: string });
        break;
      case searchSchemaTool.name:
        result = await searchSchemaTool.run(args ?? {});
        break;
      case profileTableTool.name:
        if (!args || typeof args.tableName !== "string") {
          return {
            content: [{ type: "text", text: `Missing or invalid 'tableName' argument for profile_table tool.` }],
            isError: true,
          };
        }
        result = await profileTableTool.run(args as any);
        break;
      case relationshipInspectorTool.name:
        if (!args || typeof args.tableName !== "string") {
          return {
            content: [{ type: "text", text: `Missing or invalid 'tableName' argument for inspect_relationships tool.` }],
            isError: true,
          };
        }
        result = await relationshipInspectorTool.run(args as any);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error occurred: ${error}` }],
      isError: true,
    };
  }
});

// Server startup
async function runServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Fatal error running server:", error);
    process.exit(1);
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

// Tools that are exempt from requireApproval (read-only, no data modification)
const APPROVAL_EXEMPT_TOOLS = new Set([
  "list_tables",
  "list_databases",
  "list_environments",
  "validate_environment_config",
  "list_scripts",
  "describe_table",
  "test_connection",
  "search_schema",
  "inspect_relationships",
  "inspect_dependencies",
  "read_data",
  "profile_table",
  "explain_query",
]);

// Patch all tool handlers to ensure SQL connection, policy enforcement, and audit logging
function wrapToolRun(tool: { name: string; run: (...args: any[]) => Promise<any> }) {
  const originalRun = tool.run.bind(tool);
  tool.run = async function (...args: any[]) {
    const startTime = Date.now();
    const rawArgs = (args[0] ?? {}) as Record<string, any>;
    const requestedEnvironment = typeof rawArgs.environment === "string" ? rawArgs.environment : undefined;
    const envConfig = environmentManager.getEnvironment(requestedEnvironment);

    // Build policy object from environment config
    const policy = {
      name: envConfig.name,
      readonly: envConfig.readonly ?? false,
      allowedTools: envConfig.allowedTools,
      deniedTools: envConfig.deniedTools,
      maxRowsDefault: envConfig.maxRowsDefault,
      requireApproval: envConfig.requireApproval ?? false,
      auditLevel: envConfig.auditLevel ?? "basic",
    };

    // Check denied tools policy (takes precedence)
    if (policy.deniedTools && policy.deniedTools.length > 0 && policy.deniedTools.includes(tool.name)) {
      return {
        success: false,
        message: `Tool '${tool.name}' is explicitly denied in environment '${policy.name}'.`,
        error: "TOOL_DENIED",
      };
    }

    // Check allowed tools policy
    if (policy.allowedTools && policy.allowedTools.length > 0 && !policy.allowedTools.includes(tool.name)) {
      return {
        success: false,
        message: `Tool '${tool.name}' is not permitted in environment '${policy.name}'. Allowed tools: ${policy.allowedTools.join(", ")}.`,
        error: "TOOL_NOT_ALLOWED",
      };
    }

    // Check readonly policy for mutating tools
    if (policy.readonly && MUTATING_TOOL_NAMES.has(tool.name)) {
      return {
        success: false,
        message: `Environment '${policy.name}' is read-only. Tool '${tool.name}' cannot be executed.`,
        error: "ENVIRONMENT_READONLY",
      };
    }

    // Check requireApproval policy (skip for metadata-only tools)
    if (policy.requireApproval && !APPROVAL_EXEMPT_TOOLS.has(tool.name)) {
      const hasConfirmation = rawArgs.confirm === true;
      if (!hasConfirmation) {
        return {
          success: false,
          requiresApproval: true,
          message: `Environment '${policy.name}' requires explicit approval for '${tool.name}'. Review the operation and re-run with confirm: true to proceed.`,
          error: "APPROVAL_REQUIRED",
          tool: tool.name,
          environment: policy.name,
          providedArguments: rawArgs,
          hint: "Add 'confirm: true' to your arguments after reviewing this operation.",
        };
      }
    }

    // Get connection for the specified or default environment
    const pool = await environmentManager.getConnection(policy.name);

    // Enrich args with environment info, policy, and connection pool
    const toolArgs = {
      ...rawArgs,
      environment: policy.name,
      environmentPolicy: policy,
      pool,
      mcpServerVersion: SERVER_VERSION,
    };

    try {
      const result = await originalRun(toolArgs);
      const durationMs = Date.now() - startTime;

      // Audit log the successful invocation with environment-specific audit level
      auditLogger.logToolInvocation(
        tool.name,
        toolArgs,
        result,
        durationMs,
        {
          sessionId: SESSION_ID,
          environment: policy.name,
          auditLevel: policy.auditLevel as any,
        }
      );

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Audit log the failed invocation
      auditLogger.logToolInvocation(
        tool.name,
        toolArgs,
        { success: false, error: String(error) },
        durationMs,
        {
          sessionId: SESSION_ID,
          environment: policy.name,
          auditLevel: policy.auditLevel as any,
        }
      );

      throw error;
    }
  };
}

[insertDataTool, deleteDataTool, readDataTool, updateDataTool, createTableTool, createIndexTool, dropTableTool, listTableTool, listDatabasesTool, listEnvironmentsTool, validateEnvironmentConfigTool, listScriptsTool, runScriptTool, inspectDependenciesTool, describeTableTool, searchSchemaTool, profileTableTool, relationshipInspectorTool, testConnectionTool, explainQueryTool].forEach(wrapToolRun);