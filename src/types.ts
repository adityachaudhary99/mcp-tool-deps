// A tool as returned by an MCP server's `tools/list` request.
// Mirrors MCP's wire format, but kept named `inputParameters` so the pipeline
// downstream of fetch.ts (heuristics, semantic, merge) works unchanged.
export type RawTool = {
  name: string;
  description: string;
  inputParameters: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

// A tool with its origin server attached and a globally-unique namespaced slug.
// Two different servers can both expose `read_file`; the slug `<server>::<tool>`
// disambiguates.
export type CuratedTool = RawTool & {
  slug: string;
  toolkit_slug: string;
};

export type RequiredParam = {
  name: string;
  type: string;
  description: string;
  user_supplied: boolean;
};

export type ToolNode = {
  id: string;
  toolkit: string;
  description: string;
  required_params: RequiredParam[];
};

export type Edge = {
  from: string;
  to: string;
  consumes: string;
  produces?: string;
  type: "direct" | "semantic";
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type Graph = { nodes: ToolNode[]; edges: Edge[] };

export type ServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
};

export type ServersFile = {
  servers: ServerConfig[];
};
