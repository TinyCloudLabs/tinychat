/** The only transcript capability exposed to the inference provider. */
export const TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL = {
  type: "function",
  function: {
    name: "tinycloud_search_transcripts",
    description:
      "Search the signed-in user's private TinyCloud meeting transcripts and return bounded cited evidence.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        title: { type: "string", maxLength: 160 },
        from: { type: "string" },
        to: { type: "string" },
        source: { type: "string", enum: ["fireflies", "google-meet", "tinycloud-transcriber"] },
        recent: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
} as const;

export const TRANSCRIPT_TOOL_NAME = TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL.function.name;
