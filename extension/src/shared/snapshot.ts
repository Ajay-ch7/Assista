// Page snapshot (implementation.md section 5.2). The content script builds it; the backend reads it.

export interface NodeState {
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  required?: boolean;
  /** Heading level, 1 to 6. */
  level?: number;
  /** On sensitive fields only: whether something has been typed. The value is never sent. */
  filled?: boolean;
  /** On empty fields only: a saved detail on this device fits. Its value is not sent. */
  saved?: boolean;
}

export interface SnapshotNode {
  /** Valid only for the snapshot_id it was issued with. */
  ref: string;
  role: string;
  name: string;
  text: string;
  state?: NodeState;
  /** Sensitive nodes never carry a value. */
  sensitive?: boolean;
  value?: string | null;
}

export interface SnapshotTable {
  ref: string;
  caption: string;
  rows: string[][];
}

export interface SnapshotImage {
  ref: string;
  alt: string;
  width: number;
  height: number;
}

export interface SnapshotRules {
  preticked: string[];
  countdowns: { ref: string; seconds_left: number }[];
}

export interface SnapshotFlags {
  has_canvas: boolean;
  thin: boolean;
  clutter_removed: number;
  hidden_text_removed: number;
  /** The tab shows a PDF. Its text is not in the snapshot; the backend asks for the file. */
  pdf?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  snapshot_id: string;
  nodes: SnapshotNode[];
  tables: SnapshotTable[];
  images: SnapshotImage[];
  rules: SnapshotRules;
  flags: SnapshotFlags;
}
