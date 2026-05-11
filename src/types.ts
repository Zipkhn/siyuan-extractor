export const SNAPSHOT_SCHEMA = "siyuan-snapshot/v1";

export interface WebhookPayload {
    event: "publish" | "unpublish";
    project: string;
    docId: string;
    version: number;
    publishedAt: string;
}

export interface SnapshotDoc {
    id: string;
    project: string;
    slug: string;
    title: string;
    published_at: string;
    updated_at: string;
    version: number;
    excerpt: string;
}

export interface SnapshotAsset {
    original_path: string;
    stored_path: string;
    sha256: string;
    mime: string;
    size_bytes: number;
}

export interface SnapshotOutboundRef {
    target_doc_id: string;
    target_block_id: string | null;
    anchor_text: string;
}

export type InlineMark =
    | { type: "strong"; start: number; end: number }
    | { type: "em"; start: number; end: number }
    | { type: "code"; start: number; end: number }
    | { type: "strike"; start: number; end: number }
    | { type: "link"; start: number; end: number; href: string };

export type SnapshotBlock =
    | { id: string; type: "NodeParagraph"; text: string; marks: InlineMark[]; children?: SnapshotBlock[] }
    | { id: string; type: "NodeHeading"; level: number; text: string; marks: InlineMark[] }
    | { id: string; type: "NodeList"; ordered: boolean; children: SnapshotBlock[] }
    | { id: string; type: "NodeListItem"; children: SnapshotBlock[] }
    | { id: string; type: "NodeCodeBlock"; language: string; text: string }
    | { id: string; type: "NodeBlockquote"; children: SnapshotBlock[] }
    | {
          id: string;
          type: "NodeTable";
          header_row: number;
          rows: { text: string; marks: InlineMark[] }[][];
      }
    | { id: string; type: "NodeMathBlock"; text: string }
    | { id: string; type: "NodeThematicBreak" }
    | { id: string; type: "NodeImage"; asset_id: number; alt: string; caption: string }
    | {
          id: string;
          type: "NodeAttributeView";
          view_type: "table" | "gallery";
          columns: { name: string; type: string }[];
          rows: Record<string, string>[];
      }
    | { id: string; type: "NodeSuperBlock"; layout: "row" | "col"; children: SnapshotBlock[] };

export interface Snapshot {
    schema: typeof SNAPSHOT_SCHEMA;
    doc: SnapshotDoc;
    content: {
        blocks: SnapshotBlock[];
    };
    content_hash: string; // sha256(canonical JSON of content.blocks)
    assets: SnapshotAsset[];
    outbound_refs: SnapshotOutboundRef[];
    search_text: string;
}

export interface ProjectIndexEntry {
    id: string;
    slug: string;
    title: string;
    excerpt: string;
    published_at: string;
    updated_at: string;
}

export interface ProjectIndex {
    project: string;
    name: string;
    updated_at: string;
    docs: ProjectIndexEntry[];
}
