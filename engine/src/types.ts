/** Shapes of ChatGPT data (live backend and the official export share the conversation format). */

export interface RawAuthor {
  role: string;            // user | assistant | system | tool
  name?: string | null;
}

export interface RawAttachmentMeta {
  id: string;
  name?: string;
  mime_type?: string;
  size?: number;
}

export interface RawMessage {
  id: string;
  author: RawAuthor;
  create_time?: number | null;
  update_time?: number | null;
  content: {
    content_type: string;
    parts?: unknown[];
    text?: string;
    result?: string;
    language?: string;
  };
  status?: string;
  recipient?: string;
  metadata?: {
    attachments?: RawAttachmentMeta[];
    model_slug?: string;
    is_visually_hidden_from_conversation?: boolean;
    [k: string]: unknown;
  };
}

export interface RawNode {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: RawMessage | null;
}

export interface RawConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  mapping: Record<string, RawNode>;
  current_node?: string | null;
  default_model_slug?: string | null;
  gizmo_id?: string | null;
  is_archived?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  create_time: number | null;   // unix seconds
  update_time: number | null;
  is_archived?: boolean;
}

/** One file referenced by a message (attachment or generated image). */
export interface FileRef {
  fileId: string;
  name: string;
  mime?: string;
  size?: number;
  messageId: string;
}

export interface NormalizedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  authorName?: string;
  createdAt: string | null;      // ISO 8601, null when ChatGPT has no timestamp
  model?: string;
  text: string;
  files: FileRef[];
}

export interface NormalizedConversation {
  id: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  updateTime: number | null;     // raw unix seconds, used for incremental sync
  model?: string;
  gizmoId?: string;
  archived: boolean;
  messages: NormalizedMessage[]; // the visible branch, root -> current node, in order
  branchCount: number;           // >1 when the conversation has edited/regenerated branches
  files: FileRef[];
}

export type ProgressEvent =
  | { event: 'start'; mode: string; runId: string }
  | { event: 'listed'; total: number; todo: number }
  | { event: 'progress'; done: number; total: number; id: string; title: string; status: 'saved' | 'skipped' | 'failed' }
  | { event: 'warning'; message: string; id?: string }
  | { event: 'login_required'; message: string }
  | { event: 'done'; saved: number; skipped: number; failed: number; durationSec: number }
  | { event: 'cancelled'; saved: number; message: string }
  | { event: 'phase'; phase: 'browser' | 'listing' | 'downloading' | 'reading-export'; message: string }
  | { event: 'error'; message: string };
