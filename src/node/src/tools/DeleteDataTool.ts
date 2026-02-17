import sql from "mssql";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

export class DeleteDataTool implements Tool {
  [key: string]: any;
  name = "delete_data";
  description = "Deletes rows from an MSSQL table with preview and confirmation. Requires WHERE clause for safety.";
  
  inputSchema = {
    type: "object",
    properties: {
      tableName: { 
        type: "string", 
        description: "Name of the table to delete from" 
      },
      whereClause: { 
        type: "string", 
        description: "WHERE clause to identify which rows to delete. Example: \"status = 'archived' AND created_date < '2023-01-01'\"" 
      },
      confirmDelete: {
        type: "boolean",
        description: "Set to true to confirm and execute the delete after preview. First call without this to see preview.",
      },
      maxRows: {
        type: "number",
        description: "Maximum number of rows allowed to delete. Defaults to 1000 for safety.",
      },
      environment: {
        type: "string",
        description: "Optional environment name to target",
      },
    },
    required: ["tableName", "whereClause"],
  } as any;

  private static readonly MAX_ROWS_DEFAULT = 1000;

  async run(params: any) {
    let query: string | undefined;
    try {
      const { tableName, whereClause, confirmDelete, maxRows, environment } = params;
      
      // Basic validation: ensure whereClause is not empty
      if (!whereClause || whereClause.trim() === '') {
        return {
          success: false,
          message: "WHERE clause is required for safety. Deleting all rows requires explicit WHERE clause like 'WHERE 1=1'.",
          error: "MISSING_WHERE_CLAUSE",
        };
      }

      const maxAllowed = maxRows || DeleteDataTool.MAX_ROWS_DEFAULT;

      // Step 1: Get count of affected rows
      const countQuery = `SELECT COUNT(*) as affectedRows FROM ${tableName} WHERE ${whereClause}`;
      const countRequest = new sql.Request(params.pool);
      const countResult = await countRequest.query(countQuery);
      const affectedRows = countResult.recordset[0].affectedRows;

      if (affectedRows === 0) {
        return {
          success: false,
          message: "No rows match the WHERE clause. No deletion will be performed.",
          error: "NO_ROWS_MATCHED",
          affectedRows: 0,
        };
      }

      if (affectedRows > maxAllowed) {
        return {
          success: false,
          message: `Delete would affect ${affectedRows} rows, which exceeds the maximum of ${maxAllowed}. Refine your WHERE clause or increase maxRows parameter.`,
          error: "TOO_MANY_ROWS",
          affectedRows,
          maxAllowed,
        };
      }

      // Step 2: Show preview if not confirmed
      if (!confirmDelete) {
        const previewQuery = `SELECT TOP 10 * FROM ${tableName} WHERE ${whereClause}`;
        const previewRequest = new sql.Request(params.pool);
        const previewResult = await previewRequest.query(previewQuery);

        return {
          success: false,
          needsConfirmation: true,
          message: `⚠️ WARNING: ${affectedRows} row(s) will be permanently deleted. Review the preview below and re-run with confirmDelete: true to proceed.`,
          affectedRows,
          preview: previewResult.recordset,
          error: "CONFIRMATION_REQUIRED",
        };
      }

      // Step 3: Execute the delete
      query = `DELETE FROM ${tableName} WHERE ${whereClause}`;
      const request = new sql.Request(params.pool);
      const result = await request.query(query);
      
      return {
        success: true,
        message: `Successfully deleted ${result.rowsAffected[0]} row(s) from table '${tableName}'`,
        rowsDeleted: result.rowsAffected[0],
      };
    } catch (error) {
      console.error("Error deleting data:", error);
      return {
        success: false,
        message: `Failed to delete data${query ? ` with '${query}'` : ''}: ${error}`,
        error: "DELETE_FAILED",
      };
    }
  }
}
