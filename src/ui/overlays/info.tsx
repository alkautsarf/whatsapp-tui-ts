import { createSignal, createEffect, For, Show, onMount } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { useTerminalDimensions } from "@opentui/solid";
import { truncate } from "../../utils/text.ts";
import type { StoreQueries, GroupParticipantRow } from "../../store/queries.ts";
import type { WASocket } from "@whiskeysockets/baileys";

/** Strip the WA JID suffix so the user sees a clean phone number / id. */
function bareJid(jid: string): string {
  return jid.split("@")[0] ?? jid;
}

/**
 * Contact / group info overlay. Shows display name, phone, status (DMs)
 * or member list (groups). Async-fetches whatever isn't in the local DB
 * via the live socket.
 */
export function InfoOverlay(props: {
  queries: StoreQueries;
  getSock: () => WASocket | null;
  chatJid: string;
}) {
  const { store, helpers } = useAppStore();
  const theme = useTheme();
  const dims = useTerminalDimensions();

  const isGroup = props.chatJid.endsWith("@g.us");
  const chat = () => store.chats.find((c) => c.jid === props.chatJid);

  // For DMs: status text from sock.fetchStatus
  const [statusText, setStatusText] = createSignal<string | null>(null);
  // For groups: description fetched from groupMetadata
  const [groupDesc, setGroupDesc] = createSignal<string | null>(null);
  // Live participants from groupMetadata (preferred over local DB which may
  // be stale or empty if we never received groups.upsert for this group).
  const [liveParticipants, setLiveParticipants] = createSignal<GroupParticipantRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  // Scroll offset for the participants list (manual k/j scrolling)
  const [scrollOffset, setScrollOffset] = createSignal(0);

  let inputRef: any;
  createEffect(() => {
    inputRef?.focus();
  });

  // Async fetch metadata once on mount
  onMount(() => {
    const sock = props.getSock();
    if (!sock) {
      setLoading(false);
      return;
    }
    if (isGroup) {
      sock
        .groupMetadata(props.chatJid)
        .then((meta: any) => {
          if (meta?.desc) setGroupDesc(meta.desc);
          if (meta?.participants?.length) {
            const rows: GroupParticipantRow[] = meta.participants.map((p: any) => ({
              group_jid: props.chatJid,
              user_jid: typeof p === "string" ? p : (p?.id ?? ""),
              role: typeof p === "object" ? (p?.admin ?? null) : null,
            })).filter((r: GroupParticipantRow) => r.user_jid);
            setLiveParticipants(rows);
            // Backfill the local DB so future opens are instant.
            try {
              props.queries.upsertGroupParticipants(props.chatJid, rows);
            } catch {}
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      sock
        .fetchStatus(props.chatJid)
        .then((res: any) => {
          // baileys returns { status: { status, setAt } } or array
          const text = res?.status?.status ?? res?.[0]?.status?.status ?? null;
          if (text) setStatusText(text);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  });

  function close() {
    helpers.setOverlay(null);
    helpers.setMode("normal");
  }

  function handleKeyDown(evt: any) {
    if (evt.name === "escape" || evt.name === "q") {
      evt.preventDefault?.();
      close();
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault?.();
      setScrollOffset((s) => s + 1);
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault?.();
      setScrollOffset((s) => Math.max(0, s - 1));
      return;
    }
  }

  // For groups: prefer live participants from groupMetadata (just fetched
  // from the server), fall back to local DB cache.
  const participants = () => {
    if (!isGroup) return [];
    const live = liveParticipants();
    if (live.length > 0) return live;
    return props.queries.getGroupParticipants(props.chatJid);
  };

  // Resolve display name for a participant JID
  function pName(jid: string): string {
    return props.queries.resolveContactName(jid);
  }

  const width = () => Math.min(Math.floor(dims().width * 0.55), 60);
  const height = () => Math.min(Math.floor(dims().height * 0.7), 28);

  // How many participant rows fit
  const visibleRows = () => Math.max(3, height() - 12);

  const visibleParticipants = () => {
    if (!isGroup) return [];
    const all = participants();
    return all.slice(scrollOffset(), scrollOffset() + visibleRows());
  };

  const chatDisplayName = () => {
    const c = chat();
    if (c?.name) return c.name;
    return props.queries.resolveContactName(props.chatJid);
  };

  return (
    <box
      position="absolute"
      width={dims().width}
      height={dims().height}
      justifyContent="center"
      alignItems="center"
      zIndex={3000}
    >
      <box
        flexDirection="column"
        width={width()}
        height={height()}
        border
        borderStyle="rounded"
        borderColor={theme.borderFocused}
        backgroundColor={theme.bgOverlay}
        title={isGroup ? " Group Info " : " Contact Info "}
        titleAlignment="center"
        padding={1}
      >
        {/* Header: display name + bare phone / id (no @suffix) */}
        <text fg={theme.textStrong}>{truncate(chatDisplayName(), width() - 6)}</text>
        <text fg={theme.textMuted}>{truncate(bareJid(props.chatJid), width() - 6)}</text>

        <box height={1} />

        {/* DM info */}
        <Show when={!isGroup}>
          <Show
            when={statusText()}
            fallback={
              <text fg={theme.textMuted}>{loading() ? "Loading status…" : "(no status)"}</text>
            }
          >
            <text fg={theme.text}>{truncate(statusText()!, width() - 6)}</text>
          </Show>
        </Show>

        {/* Group info */}
        <Show when={isGroup}>
          <Show when={groupDesc()}>
            {/* Render the description with explicit line wrapping. Capped
                to MAX_DESC_LINES so a long group rules block doesn't
                overflow the modal border — anything past the cap shows
                a "(see WhatsApp app for full description)" indicator.
                Hard \n breaks from WhatsApp are preserved. */}
            {(() => {
              const text = groupDesc()!;
              const wrapCols = Math.max(20, width() - 6);
              const wrapped: string[] = [];
              for (const segment of text.split("\n")) {
                if (segment.length === 0) {
                  wrapped.push("");
                  continue;
                }
                for (let i = 0; i < segment.length; i += wrapCols) {
                  wrapped.push(segment.slice(i, i + wrapCols));
                }
              }
              const MAX_DESC_LINES = 6;
              const truncated = wrapped.length > MAX_DESC_LINES;
              const visible = wrapped.slice(0, MAX_DESC_LINES);
              const totalRows = visible.length + (truncated ? 1 : 0);
              return (
                <box flexDirection="column" height={totalRows}>
                  {visible.map((line) => (
                    <text fg={theme.text}>{line}</text>
                  ))}
                  {truncated && (
                    <text fg={theme.textMuted}>{"\u2026 (see WhatsApp app for full description)"}</text>
                  )}
                </box>
              );
            })()}
            <box height={1} />
          </Show>
          <text fg={theme.textMuted}>
            {loading()
              ? "Loading members…"
              : `Members: ${participants().length}`}
          </text>
          <box height={1} />
          <For each={visibleParticipants()}>
            {(p) => (
              <box flexDirection="row">
                <text fg={p.role === "admin" || p.role === "superadmin" ? theme.borderAccent : theme.text}>
                  {p.role === "admin" || p.role === "superadmin" ? "★ " : "  "}
                </text>
                <text fg={theme.text}>{truncate(pName(p.user_jid), width() - 8)}</text>
              </box>
            )}
          </For>
          <Show when={participants().length > scrollOffset() + visibleRows()}>
            <text fg={theme.textMuted}>{`↓ ${participants().length - scrollOffset() - visibleRows()} more`}</text>
          </Show>
        </Show>

        {/* Hidden focused input for key capture. Positioned offscreen so the
            blinking cursor doesn't appear inside the modal. */}
        <box position="absolute" top={-100} left={-100} width={1} height={1}>
          <input
            ref={(el: any) => (inputRef = el)}
            width={1}
            focused
            cursorStyle={{ style: "block", blinking: false }}
            onKeyDown={handleKeyDown}
          />
        </box>
      </box>
    </box>
  );
}
