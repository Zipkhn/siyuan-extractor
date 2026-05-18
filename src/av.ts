import type {
    SiyuanAvCell,
    SiyuanAvKeyType,
    SiyuanAvRender,
} from "./siyuan-client.js";
import type {
    SnapshotAvColumn,
    SnapshotAvRow,
    SnapshotAvView,
    SnapshotBlock,
} from "./types.js";

/**
 * All views of one AV (Siyuan database) instance, plus its name and the id
 * of the default/active view. The extractor pre-fetches this per AV block
 * embedded in a doc.
 */
export interface AvBundle {
    avId: string;
    avName: string;
    defaultViewId: string;
    /** One render per view of the AV. Order matches the user's view tabs. */
    renders: SiyuanAvRender[];
}

/**
 * Known Siyuan column types we know how to format. Anything else is exposed
 * with its raw KeyType name (so the reader can still discriminate) and a
 * best-effort string value.
 */
const KNOWN_KEY_TYPES: ReadonlySet<SiyuanAvKeyType> = new Set([
    "block",
    "text",
    "number",
    "date",
    "select",
    "mSelect",
    "url",
    "email",
    "phone",
    "mAsset",
    "template",
    "created",
    "updated",
    "checkbox",
    "relation",
    "rollup",
    "lineNumber",
]);

/**
 * Convert a single AV cell to its display string. Mirrors the kernel's
 * `Value.String()` (kernel/av/value.go) but in TS. Unknown future types fall
 * back to JSON.stringify so we never lose information silently.
 */
export function cellValueToString(cell: SiyuanAvCell, rowIndex: number): string {
    const v = cell.value;
    const t = (v.type ?? cell.valueType) as SiyuanAvKeyType;
    switch (t) {
        case "block":
            return (v.block?.content ?? "").trim();
        case "text":
            return (v.text?.content ?? "").trim();
        case "number": {
            const n = v.number;
            if (!n) return "";
            if (typeof n.formattedContent === "string" && n.formattedContent.length > 0) {
                return n.formattedContent;
            }
            return typeof n.content === "number" ? String(n.content) : "";
        }
        case "date": {
            const d = v.date;
            if (!d || !d.content) return "";
            if (typeof d.formattedContent === "string" && d.formattedContent.length > 0) {
                return d.formattedContent;
            }
            const start = new Date(d.content);
            const fmt = d.isNotTime ? formatDateOnly(start) : formatDateTime(start);
            if (d.hasEndDate && d.content2) {
                const end = new Date(d.content2);
                const fmtEnd = d.isNotTime ? formatDateOnly(end) : formatDateTime(end);
                return `${fmt} → ${fmtEnd}`;
            }
            return fmt;
        }
        case "select":
        case "mSelect": {
            const opts = v.mSelect ?? [];
            return opts.map((o) => o.content ?? "").filter(Boolean).join(", ");
        }
        case "url":
            return (v.url?.content ?? "").trim();
        case "email":
            return (v.email?.content ?? "").trim();
        case "phone":
            return (v.phone?.content ?? "").trim();
        case "mAsset": {
            const assets = v.mAsset ?? [];
            return assets.map((a) => a.name || a.content || "").filter(Boolean).join(", ");
        }
        case "template":
            return (v.template?.content ?? "").trim();
        case "created": {
            const ms = v.created?.content;
            return typeof ms === "number" && ms > 0 ? formatDateTime(new Date(ms)) : "";
        }
        case "updated": {
            const ms = v.updated?.content;
            return typeof ms === "number" && ms > 0 ? formatDateTime(new Date(ms)) : "";
        }
        case "checkbox":
            return v.checkbox?.checked ? "✓" : "";
        case "relation": {
            const contents = v.relation?.contents ?? [];
            return contents
                .map((c) => c.block?.content ?? "")
                .filter(Boolean)
                .join(", ");
        }
        case "rollup": {
            // Rollup values are nested values themselves; best-effort: join
            // each entry's `block.content`, otherwise stringify.
            const contents = v.rollup?.contents ?? [];
            return contents
                .map((c) => {
                    const block = (c as { block?: { content?: string } }).block;
                    if (block?.content) return block.content;
                    return "";
                })
                .filter(Boolean)
                .join(", ");
        }
        case "lineNumber":
            return String(rowIndex + 1);
        default:
            // Unknown future type. Don't lose data.
            return JSON.stringify(v);
    }
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function formatDateOnly(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(d: Date): string {
    return `${formatDateOnly(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Map the type field of a column to what we store in the snapshot. Known
 * types pass through; unknown types are recorded as "unknown" so the reader
 * can render a neutral cell without guessing.
 */
function columnType(type: string): string {
    return KNOWN_KEY_TYPES.has(type as SiyuanAvKeyType) ? type : "unknown";
}

export interface AvBlockConversion {
    block: SnapshotBlock;
    /** Synthesized HTML fallback (always a <table>) — the active/default view rendered flat. */
    html: string;
}

/**
 * Convert a bundle (all views of an AV) into a snapshot block with `views[]`,
 * plus an HTML fallback table for the default view. The reader uses `views[]`
 * to drive its tab switcher; the HTML table is the no-JS / older-snapshot
 * fallback inside the <av-placeholder>.
 */
export function convertAttributeView(
    nodeId: string,
    bundle: AvBundle,
): AvBlockConversion {
    const views: SnapshotAvView[] = bundle.renders.map((r) => buildSnapshotView(r));
    const fallbackView =
        views.find((v) => v.id === bundle.defaultViewId) ?? views[0] ?? null;

    const block: SnapshotBlock = {
        id: nodeId,
        type: "NodeAttributeView",
        av_name: bundle.avName,
        default_view_id: bundle.defaultViewId,
        views,
    };

    const html = fallbackView
        ? renderAvHtml(bundle.avName, fallbackView.columns, fallbackView.rows)
        : `<table class="av-block"><caption>${escapeHtml(bundle.avName)}</caption></table>`;
    return { block, html };
}

function buildSnapshotView(render: SiyuanAvRender): SnapshotAvView {
    const view = render.view;

    // Table layout uses columns+rows; kanban/gallery use fields+cards; a
    // grouped kanban additionally nests its cards inside view.groups[i].cards
    // (one entry per group/status). Collect from every shape and flatten
    // everything to a single columns[] + rows[] pair.
    const rawColumns = view?.columns ?? view?.fields ?? [];
    const tableRows = view?.rows ?? [];
    const directCards = view?.cards ?? [];
    const groupedCards = Array.isArray(view?.groups)
        ? view.groups.flatMap((g) => g.cards ?? [])
        : [];

    const usingTableRows = tableRows.length > 0;
    const cardItems = directCards.length > 0 ? directCards : groupedCards;

    const visibleColumns = rawColumns.filter((c) => !c.hidden);
    const visibleColIds = new Set(visibleColumns.map((c) => c.id));

    const columns: SnapshotAvColumn[] = visibleColumns.map((c) => ({
        id: c.id,
        name: c.name,
        type: columnType(c.type),
    }));

    const rows: SnapshotAvRow[] = (usingTableRows ? tableRows : cardItems).map(
        (item, rowIndex) => {
            const cellsByColId = new Map<string, string>();
            const cellLike = usingTableRows
                ? (item as (typeof tableRows)[number]).cells
                : (item as (typeof cardItems)[number]).values;
            for (const cell of cellLike) {
                const keyId = (cell.value.keyID as string | undefined) ?? "";
                if (!visibleColIds.has(keyId)) continue;
                cellsByColId.set(keyId, cellValueToString(cell, rowIndex));
            }
            const cells = visibleColumns.map((c) => cellsByColId.get(c.id) ?? "");
            return { id: item.id, cells };
        },
    );

    const rawType = render.viewType ?? view?.type;
    const type: SnapshotAvView["type"] =
        rawType === "table" || rawType === "gallery" || rawType === "kanban"
            ? rawType
            : "unknown";

    // Kanban group_key_id: try groupKey.id first (av.Key.ID), fall back to
    // group.field (av.ViewGroup.Field). Either reliably points at the
    // grouping column. null → reader silently degrades to table.
    const groupKeyId =
        type === "kanban"
            ? (view?.groupKey?.id ?? view?.group?.field ?? null)
            : null;

    return {
        id: render.viewID,
        name: view?.name ?? "",
        type,
        columns,
        rows,
        ...(type === "kanban" ? { group_key_id: groupKeyId } : {}),
    };
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Render the AV as a sanitization-friendly <table>. Always uses table layout
 * even for gallery/kanban — readers wanting card layouts can re-derive from
 * the typed JSON.
 */
export function renderAvHtml(
    name: string,
    columns: SnapshotAvColumn[],
    rows: SnapshotAvRow[],
): string {
    const caption = name ? `<caption>${escapeHtml(name)}</caption>` : "";
    const headerCells = columns
        .map((c) => `<th scope="col" data-av-col-type="${escapeHtml(c.type)}">${escapeHtml(c.name)}</th>`)
        .join("");
    const head = `<thead><tr>${headerCells}</tr></thead>`;
    const bodyRows = rows
        .map((row) => {
            const cells = row.cells
                .map((cell) => `<td>${escapeHtml(cell)}</td>`)
                .join("");
            return `<tr>${cells}</tr>`;
        })
        .join("");
    const body = `<tbody>${bodyRows}</tbody>`;
    return `<table class="av-block">${caption}${head}${body}</table>`;
}
