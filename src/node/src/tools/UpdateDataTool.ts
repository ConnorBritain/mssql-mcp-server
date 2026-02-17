import sql from "mssql";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

export class UpdateDataTool implements Tool {
  [key: string]: any;
  name = "update_data";
  description = "Updates rows in an MSSQL table with preview and confirmation. Requires WHERE clause for safety.";
  inputSchema = {
    type: "object",
    properties: {
      tableName: { 
        type: "string", 
        description: "Name of the table to update" 
      },
      updates: {
        type: "object",
        description: "Key-value pairs of columns to update. Example: { 'status': 'active', 'last_updated': '2025-01-01' }",
      },
      whereClause: { 
        type: "string", 
        description: "WHERE clause to identify which records to update. Example: \"genre = 'comedy' AND created_date <= '2025-07-05'\"" 
      },
      confirmUpdate: {
        type: "boolean",
        description: "Set to true to confirm and execute the update after preview. First call without this to see preview.",
      },
      maxRows: {
        type: "number",
        description: "Maximum number of rows allowed to update. Defaults to 1000 for safety.",
      },
      environment: {
        type: "string",
        description: "Optional environment name to target",
      },
    },
    required: ["tableName", "updates", "whereClause"],
  } as any;

  private static readonly MAX_ROWS_DEFAULT = 1000;

  async run(params: any) {
    let query: string | undefined;
    try {
      const { tableName, updates, whereClause, confirmUpdate, maxRows, environment } = params;
      
      // Basic validation: ensure whereClause is not empty
      if (!whereClause || whereClause.trim() === '') {
        return {
          success: false,
          message: "WHERE clause is required for security reasons. Use 'WHERE 1=1' to update all rows (not recommended).",
          error: "MISSING_WHERE_CLAUSE",
        };
      }

      const maxAllowed = maxRows || UpdateDataTool.MAX_ROWS_DEFAULT;

      // Step 1: Get count of affected rows
      const countQuery = `SELECT COUNT(*) as affectedRows FROM ${tableName} WHERE ${whereClause}`;
      const countRequest = new sql.Request(params.pool);
      const countResult = await countRequest.query(countQuery);
      const affectedRows = countResult.recordset[0].affectedRows;

      if (affectedRows === 0) {
        return {
          success: false,
          message: "No rows match the WHERE clause. No update will be performed.",
          error: "NO_ROWS_MATCHED",
          affectedRows: 0,
        };
      }

      if (affectedRows > maxAllowed) {
        return {
          success: false,
          message: `Update would affect ${affectedRows} rows, which exceeds the maximum of ${maxAllowed}. Refine your WHERE clause or increase maxRows parameter.`,
          error: "TOO_MANY_ROWS",
          affectedRows,
          maxAllowed,
        };
      }

      // Step 2: Show preview if not confirmed
      if (!confirmUpdate) {
        const previewQuery = `SELECT TOP 10 * FROM ${tableName} WHERE ${whereClause}`;
        const previewRequest = new sql.Request(params.pool);
        const previewResult = await previewRequest.query(previewQuery);

        return {
          success: false,
          needsConfirmation: true,
          message: `Preview: ${affectedRows} row(s) will be updated. Review the preview below and re-run with confirmUpdate: true to proceed.`,
          affectedRows,
          preview: previewResult.recordset,
          updates,
          error: "CONFIRMATION_REQUIRED",
        };
      }

      // Step 3: Execute the update
      const request = new sql.Request(params.pool);
      
      // Build SET clause with parameterized queries for security
      const setClause = Object.keys(updates)
        .map((key, index) => {
          const paramName = `update_${index}`;
          request.input(paramName, updates[key]);
          return `[${key}] = @${paramName}`;
        })
        .join(", ");

      query = `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause}`;
      const result = await request.query(query);
      
      return {
        success: true,
        message: `Successfully updated ${result.rowsAffected[0]} row(s) in table '${tableName}'`,
        rowsAffected: result.rowsAffected[0],
        updates,
      };
    } catch (error) {
      console.error("Error updating data:", error);
      return {
        success: false,
        message: `Failed to update data${query ? ` with '${query}'` : ''}: ${error}`,
        error: "UPDATE_FAILED",
      };
    }
  }
}
