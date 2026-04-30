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

const MANIM_BIN = process.env.MANIM_BIN_PATH || "/home/yuki/.local/bin/manim";

// ── Helpers ──
function findManimOutput(workdir, className, scriptBasename) {
  const mediaDir = join(workdir, "media", "images", scriptBasename.replace(/\.py$/, ""));
  if (!existsSync(mediaDir)) return null;

  // Look for ClassName_ManimCE_v*.png
  const files = readdirSync(mediaDir);
  const pattern = new RegExp(`^${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_ManimCE_v\\d+\\.\\d+\\.\\d+\\.png$`);
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
            description: "Absolute path to the Manim Python script (.py).",
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
              "Optional. Copy the output PNG to this path. Defaults to /tmp/<class_name>.png",
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

    try {
      // Run manim
      const result = execFileSync(
        MANIM_BIN,
        [`-pq${quality}`, scriptBasename, className],
        {
          cwd: scriptDir,
          timeout: 120000, // 2 min timeout
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      // Find the output PNG
      const pngPath = findManimOutput(scriptDir, className, scriptBasename);
      if (!pngPath) {
        // Try to parse from manim output
        const match = result.match(/File ready at\s+(.+\.png)/);
        if (match) {
          const found = match[1].trim();
          const output = args.output_path || join(tmpdir(), `${className}.png`);
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

      // Copy to predictable output path
      const output =
        args.output_path || join(tmpdir(), `${className}.png`);
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
      const stdout = e.stdout || "";
      return {
        content: [
          {
            type: "text",
            text: `Manim render failed for ${className}:\nSTDERR: ${stderr.slice(-1000)}\nSTDOUT: ${stdout.slice(-500)}`,
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
