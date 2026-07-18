import type { ProviderDefinition } from "../../core/types.ts";

import { openscadActions } from "./actions.ts";

const service = "openscad";

/**
 * Self-hosted OpenSCAD provider. Targets a locally reachable headless OpenSCAD
 * render microservice (default http://host.docker.internal:8910, the OrbStack
 * host gateway) that wraps the openscad CLI. No API key is sent; the local path
 * bypasses any public gate. Actions render .scad source into 3D models
 * (STL/OFF/3MF), 2D vectors (SVG/DXF/PDF), or a PNG preview, returned as
 * downloadable transit files.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "OpenSCAD (Self-Hosted)",
  categories: ["Design & Media", "Developer Tools"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Base URL",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "http://host.docker.internal:8910",
          description:
            "Base URL of your headless OpenSCAD render microservice. Leave blank to use http://host.docker.internal:8910 (the OrbStack host gateway). No API key is required.",
        },
      ],
      testAction: { actionName: "info", input: {} },
    },
  ],
  homepageUrl: "https://openscad.org",
  actions: openscadActions,
};
