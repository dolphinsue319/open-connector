import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "openscad";

// OpenSCAD -D overrides: top-level scalar variable values applied per render.
const paramsSchema = s.record(
  s.oneOf([s.string("A string value."), s.number("A numeric value."), s.boolean("A boolean value.")], {
    description: "An OpenSCAD variable override value.",
  }),
  { description: "Top-level OpenSCAD variable overrides applied with -D (name=value)." },
);

// The produced output file, stored in local transit storage.
const renderedFileSchema: JsonSchema = s.looseRequiredObject(
  "The rendered output file stored in local transit storage.",
  {
    name: s.string("The output filename."),
    mimetype: s.string("The output MIME type."),
    downloadUrl: s.string("The transit URL for downloading the output."),
    fileId: s.string("The local transit file identifier."),
    sizeBytes: s.integer("The output size in bytes."),
  },
);

const colorschemes = [
  "Cornfield",
  "Metallic",
  "Sunset",
  "Starnight",
  "BeforeDawn",
  "Nature",
  "DeepOcean",
  "Solarized",
  "Tomorrow",
  "Tomorrow Night",
  "Monotone",
];

/**
 * render_model and render_2d share the same source/format/params/filename input
 * and {format, file} output; they differ only by copy, the format enum, and
 * whether `format` is optional (a 3D default exists; 2D has no single default).
 */
function defineRenderAction(
  name: "render_model" | "render_2d",
  options: {
    description: string;
    formats: string[];
    formatDescription: string;
    sourceDescription: string;
    outputDescription: string;
    formatOptional: boolean;
  },
): ActionDefinition {
  return defineProviderAction(service, {
    name,
    description: options.description,
    inputSchema: s.looseRequiredObject(
      "The input payload for this action.",
      {
        source: s.nonEmptyString(options.sourceDescription),
        format: s.stringEnum(options.formatDescription, options.formats),
        params: paramsSchema,
        filename: s.string("Optional base filename (without extension) for the output."),
      },
      { optional: options.formatOptional ? ["format", "params", "filename"] : ["params", "filename"] },
    ),
    outputSchema: s.looseRequiredObject(options.outputDescription, {
      format: s.string("The output format that was produced."),
      file: renderedFileSchema,
    }),
  });
}

export const openscadActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "info",
    description: "Report the headless OpenSCAD render service health and version.",
    inputSchema: s.looseObject({}, { description: "The input payload for this action." }),
    outputSchema: s.looseRequiredObject(
      "The OpenSCAD render service status.",
      {
        ok: s.boolean("Whether the render service is healthy."),
        version: s.string("The OpenSCAD version string."),
      },
      { optional: ["version"] },
    ),
  }),
  defineRenderAction("render_model", {
    description:
      "Render OpenSCAD source into a 3D model file (STL, OFF, or 3MF) and return a downloadable transit file.",
    formats: ["stl", "off", "3mf"],
    formatDescription: "The 3D output format.",
    sourceDescription: "The OpenSCAD (.scad) source code to render.",
    outputDescription: "The rendered model output.",
    formatOptional: true,
  }),
  defineRenderAction("render_2d", {
    description:
      "Render an OpenSCAD 2D design into a vector file (SVG, DXF, or PDF) and return a downloadable transit file. The source must produce 2D geometry (2D primitives such as square/circle, or a projection() of a 3D model).",
    formats: ["svg", "dxf", "pdf"],
    formatDescription: "The 2D vector output format.",
    sourceDescription: "The OpenSCAD (.scad) source code to render. Must evaluate to 2D geometry.",
    outputDescription: "The rendered 2D output.",
    formatOptional: false,
  }),
  defineProviderAction(service, {
    name: "render_preview",
    description: "Render an OpenSCAD scene to a PNG preview image and return a downloadable transit file.",
    inputSchema: s.looseRequiredObject(
      "The input payload for this action.",
      {
        source: s.nonEmptyString("The OpenSCAD (.scad) source code to render."),
        params: paramsSchema,
        imgsize: s.string("Image size as WIDTH,HEIGHT (e.g. 1024,768). Defaults to 512,512."),
        camera: s.string(
          "OpenSCAD --camera argument: either translate/rotate/dist (7 numbers) or eye/center (6 numbers), comma-separated.",
        ),
        colorscheme: s.stringEnum("The OpenSCAD color scheme.", colorschemes),
        projection: s.stringEnum("The camera projection.", ["perspective", "orthogonal"]),
        filename: s.string("Optional base filename (without extension) for the PNG."),
      },
      { optional: ["params", "imgsize", "camera", "colorscheme", "projection", "filename"] },
    ),
    outputSchema: s.looseRequiredObject("The rendered preview output.", {
      file: renderedFileSchema,
    }),
  }),
];

export type OpenscadActionName = "info" | "render_model" | "render_2d" | "render_preview";
