// The four meeting tools Main (TrustBot) may call, in MCP form. A copy of backend/src/transcripts/tool-contract.ts
// (TINYCLOUD_MEETING_TOOLS): the bots service does not import backend code. backend/src/trustbot-reads/
// tool-copy.test.ts fails when the two differ.
// Details: TC-3792

export const MEETING_TOOLS = [
  {
    "name": "tinycloud_find_meetings",
    "description": "Find the signed-in user's private meetings by title, participant, date, or recency without reading transcript text. Use this first for latest/last meeting questions or to resolve which meeting the user means. Set selectFirst=true only when the user clearly asks for the first/newest result. Copy each returned meeting's exact citation field after any fact stated about that meeting.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional meeting-title substring."
        },
        "participant": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional participant name, email, or email-domain substring."
        },
        "from": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "Inclusive YYYY-MM-DD lower bound in the user's local calendar."
        },
        "to": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "Inclusive YYYY-MM-DD upper bound in the user's local calendar."
        },
        "source": {
          "type": "string",
          "enum": [
            "fireflies",
            "granola",
            "google-meet",
            "tinycloud-transcriber",
            "exo-local",
            "exo-merged"
          ]
        },
        "sort": {
          "type": "string",
          "enum": [
            "newest",
            "oldest"
          ],
          "description": "Result order. Defaults to newest."
        },
        "selectFirst": {
          "type": "boolean",
          "description": "Remember the first result as this room's selected meeting for follow-up prompts."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "Maximum metadata records to return; defaults to five."
        },
        "meetingRef": {
          "type": "string",
          "maxLength": 128,
          "description": "Exact opaque meeting reference for metadata lookup."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "tinycloud_read_meeting",
    "description": "Read bounded cited evidence from one private meeting. Pass a meetingRef returned by tinycloud_find_meetings, or omit it to reuse this room's selected meeting. This tool is mandatory for an immediate follow-up about a selected meeting, including 'what next?', 'what did we decide?', 'summarize it', or 'what did they say?'. Use focus=actions for explicit next steps, focus=speaker for what one person said, and copy each exact citation field after the claim it supports. Never infer unsupported decisions or todos.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "meetingRef": {
          "type": "string",
          "maxLength": 128,
          "description": "Optional opaque meetingRef copied exactly from TinyCloud tool data. Never pass a citation such as M1 or [M1]. Omit this field for a follow-up about the room's selected meeting."
        },
        "focus": {
          "type": "string",
          "enum": [
            "summary",
            "actions",
            "decisions",
            "speaker",
            "transcript"
          ]
        },
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500,
          "description": "Optional topic or phrase used to select bounded transcript evidence."
        },
        "speaker": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "description": "Required for focus=speaker; filters evidence to that attributed speaker."
        },
        "assignee": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional explicit assignee filter for stored action items."
        },
        "includeBody": {
          "type": "boolean",
          "description": "Read body evidence even when a stored overview or actions exist."
        }
      },
      "required": [
        "focus"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "tinycloud_search_transcripts",
    "description": "Search the signed-in user's private meeting content for a topic or phrase and return bounded cited evidence. Do not use this for metadata-only latest/last meeting questions; use tinycloud_find_meetings instead.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "title": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional meeting-title substring."
        },
        "participant": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional participant name, email, or email-domain substring."
        },
        "from": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "Inclusive YYYY-MM-DD lower bound in the user's local calendar."
        },
        "to": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "Inclusive YYYY-MM-DD upper bound in the user's local calendar."
        },
        "source": {
          "type": "string",
          "enum": [
            "fireflies",
            "granola",
            "google-meet",
            "tinycloud-transcriber",
            "exo-local",
            "exo-merged"
          ]
        },
        "speaker": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional attributed-speaker filter."
        },
        "meetingRef": {
          "type": "string",
          "maxLength": 128,
          "description": "Optional opaque reference that restricts search to one meeting."
        },
        "sort": {
          "type": "string",
          "enum": [
            "newest",
            "oldest"
          ]
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "tinycloud_list_meeting_actions",
    "description": "Aggregate explicit action-item evidence across the signed-in user's private meetings in a bounded date range. Use only for daily todos or actions across a stated date range or multiple meetings. Never use for an immediate follow-up about one selected meeting; use tinycloud_read_meeting instead. Copy each exact citation field after the claim it supports. Do not claim a candidate transcript excerpt is an assigned todo unless it explicitly states the action and owner.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional meeting-title substring."
        },
        "participant": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional participant name, email, or email-domain substring."
        },
        "from": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "Inclusive YYYY-MM-DD lower bound in the user's local calendar."
        },
        "to": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "Inclusive YYYY-MM-DD upper bound in the user's local calendar."
        },
        "source": {
          "type": "string",
          "enum": [
            "fireflies",
            "granola",
            "google-meet",
            "tinycloud-transcriber",
            "exo-local",
            "exo-merged"
          ]
        },
        "assignee": {
          "type": "string",
          "maxLength": 160,
          "description": "Optional explicit assignee name to match in structured action items; do not pass 'me' unless the user's name is known."
        },
        "includeBody": {
          "type": "boolean",
          "description": "Read body evidence for every included meeting even when stored actions exist."
        },
        "sort": {
          "type": "string",
          "enum": [
            "newest",
            "oldest"
          ]
        }
      },
      "additionalProperties": false
    }
  }
] as const;

export type MeetingToolName = (typeof MEETING_TOOLS)[number]["name"];
export const MEETING_TOOL_NAMES: readonly MeetingToolName[] = MEETING_TOOLS.map(tool => tool.name);
