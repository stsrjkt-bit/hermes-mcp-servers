#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "child_process";
import { existsSync, readdirSync, copyFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";

const MANIM_BIN = process.env.MANIM_BIN || "/home/yuki/.local/bin/manim";

// ── Allowed output directory ──
const ALLOWED_OUTPUT_DIR = process.env.OUTPUT_DIR || tmpdir();

function validateOutputPath(p) {
  const resolved = join(p);
  const allowed = join(ALLOWED_OUTPUT_DIR);
  if (!resolved.startsWith(allowed)) {
    throw new Error(`output_path must be under ${allowed}, got: ${p}`);
  }
}

// ── Helpers ──
function findManimOutput(workdir, className, scriptBasename) {
  const mediaDir = join(workdir, "media", "images", scriptBasename.replace(/\.py$/, ""));
  if (!existsSync(mediaDir)) return null;

  const files = readdirSync(mediaDir);
  const escapedName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedName}_ManimCE_v\\d+\\.\\d+\\.\\d+\\.png$`);
  for (const f of files) {
    if (pattern.test(f)) {
      return join(mediaDir, f);
    }
  }
  return null;
}

// ── Server ──
const server = new Server(
  { name: "manim-png", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "manim_render",
      description:
        "Render a Manim Python script to a static PNG image. Runs `manim -pql` (low quality, fast) by default. Use for generating diagrams, math figures, physics illustrations for worksheets.",
      inputSchema: {
        type: "object",
        properties: {
          script_path: {
            type: "string",
            description: "Absolute path to the Manim Python script (.py). Must be under /tmp/ or the current workspace.",
          },
          class_name: {
            type: "string",
            description: "The Scene class name to render (e.g., 'MyCircuit').",
          },
          quality: {
            type: "string",
            enum: ["l", "m", "h", "k"],
            default: "l",
            description:
              "Quality: l=480p(fast), m=720p, h=1080p, k=4K. Default: l.",
          },
          output_path: {
            type: "string",
            description:
              "Optional. Copy the output PNG to this path. Must be under /tmp/. Defaults to /tmp/<class_name>.png",
          },
        },
        required: ["script_path", "class_name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "manim_render") {
    // Validate required args
    if (args.class_name == null || args.class_name === "") {
      return {
        content: [{ type: "text", text: "Error: class_name is required and must not be empty" }],
        isError: true,
      };
    }

    const scriptPath = resolve(args.script_path);
    if (!existsSync(scriptPath)) {
      return {
        content: [
          { type: "text", text: `Error: Script not found: ${scriptPath}` },
        ],
        isError: true,
      };
    }

    const className = args.class_name;
    const quality = args.quality || "l";
    const scriptDir = dirname(scriptPath);
    const scriptBasename = basename(scriptPath);

    // Validate output path
    const output = args.output_path || join(tmpdir(), `${className}.png`);
    try { validateOutputPath(output); } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }

    try {
      const result = execFileSync(
        MANIM_BIN,
        [`-pq${quality}`, scriptBasename, className],
        {
          cwd: scriptDir,
          timeout: 120000,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      const pngPath = findManimOutput(scriptDir, className, scriptBasename);
      if (!pngPath) {
        const match = result.match(/File ready at\s+(.+\.png)/);
        if (match) {
          const found = match[1].trim();
          copyFileSync(found, output);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ png_path: output, quality: quality }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Manim ran but could not find output PNG for ${className}. Output: ${result.slice(-500)}`,
            },
          ],
          isError: true,
        };
      }

      copyFileSync(pngPath, output);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ png_path: output, quality: quality }),
          },
        ],
      };
    } catch (e) {
      const stderr = e.stderr || "";
      return {
        content: [
          {
            type: "text",
            text: `Manim render failed for ${className}:\nSTDERR: ${stderr.slice(-2000)}`,
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ── Start ──
const transport = new StdioServerTransport();
await server.connect(transport);
