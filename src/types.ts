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
    | { id: string; type: "NodeImage"; asset_path: string; alt: string; caption: string }
    | {
          id: string;
          type: "NodeAttributeView";
          view_type: "table" | "gallery" | "kanban";
          av_name: string;
          view_name: string;
          columns: SnapshotAvColumn[];
          rows: SnapshotAvRow[];
      }
    | { id: string; type: "NodeSuperBlock"; layout: "row" | "col"; children: SnapshotBlock[] };

export interface SnapshotAvColumn {
    id: string;
    name: string;
    /**
     * Siyuan KeyType (block, text, number, date, select, mSelect, url, email,
     * phone, mAsset, template, created, updated, checkbox, relation, rollup,
     * lineNumber). Types the extractor doesn't know how to format produce a
     * best-effort string and keep their raw KeyType here so the reader can
     * still decide how to render them. Unknown future types pass through as
     * "unknown".
     */
    type: string;
}

export interface SnapshotAvRow {
    id: string;
    /** Display strings, indexed the same as `columns`. Same length as columns. */
    cells: string[];
}

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

