#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// ── Playwright ──
const PLAYWRIGHT_INDEX =
  process.env.PLAYWRIGHT_INDEX_PATH ||
  "/home/yuki/fukutannin-config/seo/skills/seo/.venv/lib/python3.12/site-packages/playwright/driver/package/index.mjs";

// ── Allowed output directory ──
const ALLOWED_OUTPUT_DIR = process.env.OUTPUT_DIR || tmpdir();

function validateOutputPath(p) {
  const resolved = join(p); // resolve ".." etc
  const allowed = join(ALLOWED_OUTPUT_DIR);
  if (!resolved.startsWith(allowed)) {
    throw new Error(`output_path must be under ${allowed}, got: ${p}`);
  }
}

// ── Server ──
const server = new Server(
  { name: "html-to-pdf", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tools ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "html_to_pdf",
      description:
        "Convert HTML file(s) to a single merged A4 PDF using Playwright. Accepts a single path or array of paths. Returns the output PDF path and page count.",
      inputSchema: {
        type: "object",
        properties: {
          html_path: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Absolute path to HTML file, or array of paths (for multi-page PDF).",
          },
          output_path: {
            type: "string",
            description:
              "Optional output PDF path. Must be under /tmp/. Defaults to /tmp/worksheet-<timestamp>.pdf",
          },
          format: {
            type: "string",
            enum: ["A4", "A3", "Letter"],
            default: "A4",
            description: "Paper format (default: A4).",
          },
          margin: {
            type: "string",
            default: "8mm 12mm 8mm 12mm",
            description:
              "CSS margin string (top right bottom left). Default: '8mm 12mm 8mm 12mm'",
          },
        },
        required: ["html_path"],
      },
    },
    {
      name: "pdf_merge",
      description:
        "Merge multiple PDF files into one using Ghostscript. Returns the merged PDF path.",
      inputSchema: {
        type: "object",
        properties: {
          pdf_paths: {
            type: "array",
            items: { type: "string" },
            description: "Array of absolute paths to PDF files to merge.",
          },
          output_path: {
            type: "string",
            description:
              "Optional output path. Must be under /tmp/. Defaults to /tmp/merged-<timestamp>.pdf",
          },
        },
        required: ["pdf_paths"],
      },
    },
    {
      name: "pdf_info",
      description:
        "Get page count and other info about a PDF file using pdfinfo.",
      inputSchema: {
        type: "object",
        properties: {
          pdf_path: {
            type: "string",
            description: "Absolute path to the PDF file.",
          },
        },
        required: ["pdf_path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "html_to_pdf": {
      // Validate html_path is provided and not null/undefined
      if (args.html_path == null || args.html_path === "") {
        return {
          content: [{ type: "text", text: "Error: html_path is required and must not be empty" }],
          isError: true,
        };
      }
      const paths = Array.isArray(args.html_path)
        ? args.html_path
        : [args.html_path];
      const output =
        args.output_path ||
        join(tmpdir(), `worksheet-${randomUUID()}.pdf`);
      const margin = args.margin || "8mm 12mm 8mm 12mm";

      // Validate output path
      try { validateOutputPath(output); } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }

      // Validate all HTML files exist
      for (const p of paths) {
        if (!existsSync(p)) {
          return {
            content: [{ type: "text", text: `Error: HTML file not found: ${p}` }],
            isError: true,
          };
        }
      }

      // Convert each HTML to PDF via Playwright
      const pdfPaths = [];
      for (let i = 0; i < paths.length; i++) {
        const tmpPdf = join(tmpdir(), `page-${randomUUID()}.pdf`);
        const scriptPath = join(tmpdir(), `_gen_pdf_${randomUUID()}.mjs`);
        const genScript = `
import { chromium } from ${JSON.stringify(PLAYWRIGHT_INDEX)};
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(${JSON.stringify('file://' + paths[i])}, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1200);
await page.pdf({
  path: ${JSON.stringify(tmpPdf)},
  format: ${JSON.stringify(args.format || "A4")},
  printBackground: true,
  margin: { top: ${JSON.stringify(margin.split(" ")[0] || "8mm")}, right: ${JSON.stringify(margin.split(" ")[1] || "12mm")}, bottom: ${JSON.stringify(margin.split(" ")[2] || "8mm")}, left: ${JSON.stringify(margin.split(" ")[3] || "12mm")} }
});
await browser.close();
console.log('OK:' + ${JSON.stringify(tmpPdf)});
`;
        writeFileSync(scriptPath, genScript);
        try {
          const result = execFileSync("node", [scriptPath], {
            timeout: 60000,
            encoding: "utf8",
          });
          try { unlinkSync(scriptPath); } catch (_) {}
          if (result.includes("OK:")) {
            pdfPaths.push(tmpPdf);
          } else {
            // Clean up temp PDF on failure
            try { unlinkSync(tmpPdf); } catch (_) {}
            return {
              content: [{ type: "text", text: `PDF generation failed for ${paths[i]}: ${result}` }],
              isError: true,
            };
          }
        } catch (e) {
          try { unlinkSync(scriptPath); } catch (_) {}
          try { unlinkSync(tmpPdf); } catch (_) {}
          return {
            content: [{ type: "text", text: `PDF generation error for ${paths[i]}: ${e.stderr || e.message}` }],
            isError: true,
          };
        }
      }

      // Merge if multiple pages
      let finalPdf;
      if (pdfPaths.length === 1) {
        finalPdf = pdfPaths[0];
        if (finalPdf !== output) {
          execFileSync("cp", [finalPdf, output]);
          finalPdf = output;
        }
      } else {
        execFileSync("gs", [
          "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pdfwrite",
          `-sOutputFile=${output}`,
          ...pdfPaths,
        ]);
        finalPdf = output;
        for (const p of pdfPaths) {
          try { unlinkSync(p); } catch (_) {}
        }
      }

      // Get page count
      let pages = "?";
      try {
        const info = execFileSync("pdfinfo", [finalPdf], {
          encoding: "utf8",
          timeout: 5000,
        });
        const m = info.match(/Pages:\s+(\d+)/);
        if (m) pages = m[1];
      } catch (_) {}

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pdf_path: finalPdf,
              pages: parseInt(pages) || pages,
              input_count: paths.length,
            }),
          },
        ],
      };
    }

    case "pdf_merge": {
      const paths = args.pdf_paths;
      const output =
        args.output_path ||
        join(tmpdir(), `merged-${randomUUID()}.pdf`);

      try { validateOutputPath(output); } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }

      for (const p of paths) {
        if (!existsSync(p)) {
          return {
            content: [{ type: "text", text: `Error: PDF not found: ${p}` }],
            isError: true,
          };
        }
      }

      if (paths.length === 1) {
        execFileSync("cp", [paths[0], output]);
      } else {
        execFileSync("gs", [
          "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pdfwrite",
          `-sOutputFile=${output}`,
          ...paths,
        ]);
      }

      let pages = "?";
      try {
        const info = execFileSync("pdfinfo", [output], { encoding: "utf8" });
        const m = info.match(/Pages:\s+(\d+)/);
        if (m) pages = m[1];
      } catch (_) {}

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              merged_path: output,
              pages: parseInt(pages) || pages,
              input_count: paths.length,
            }),
          },
        ],
      };
    }

    case "pdf_info": {
      const path = args.pdf_path;
      if (!existsSync(path)) {
        return {
          content: [{ type: "text", text: `Error: PDF not found: ${path}` }],
          isError: true,
        };
      }

      try {
        const info = execFileSync("pdfinfo", [path], {
          encoding: "utf8",
          timeout: 5000,
        });
        const parsed = {};
        for (const line of info.split("\n")) {
          const [k, ...v] = line.split(":");
          if (k && v.length) parsed[k.trim()] = v.join(":").trim();
        }
        return {
          content: [{ type: "text", text: JSON.stringify(parsed) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `pdfinfo error: ${e.message}` }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ── Start ──
const transport = new StdioServerTransport();
await server.connect(transport);
