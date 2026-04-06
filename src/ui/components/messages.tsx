import { For, Show, createMemo } from "solid-js";
import { useAppStore } from "../state.tsx";
import { useTheme } from "../theme.tsx";
import { MessageBubble, type BubbleProps } from "./message-bubble.tsx";
import type { StoreQueries, MessageRow } from "../../store/queries.ts";

interface GroupedMessage {
  message: MessageRow;
  showSender: boolean;
  showDate: boolean;
  senderName: string;
  quotedText: string | null;
}

function isSameDay(ts1: number, ts2: number): boolean {
  const d1 = new Date(ts1 * 1000);
  const d2 = new Date(ts2 * 1000);
  return (
    d1.getDate() === d2.getDate() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getFullYear() === d2.getFullYear()
  );
}

export function Messages(props: { queries: StoreQueries; scrollRef?: (el: any) => void }) {
  const { store } = useAppStore();
  const theme = useTheme();

  const isFocused = () => store.focusZone === "messages";

  const groupedMessages = createMemo((): GroupedMessage[] => {
    const jid = store.selectedChatJid;
    if (!jid) return [];
    const raw = store.messages[jid];
    if (!raw || raw.length === 0) return [];

    // Messages are stored newest-first, reverse for display (oldest first)
    const msgs = [...raw].reverse();
    const result: GroupedMessage[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]!;
      const prev = i > 0 ? msgs[i - 1]! : null;

      const sameDay = prev ? isSameDay(prev.timestamp, msg.timestamp) : false;
      const showDate = !sameDay;

      // Group consecutive messages from same sender (within same day, within 5 min)
      const sameSender =
        prev &&
        sameDay &&
        prev.sender_jid === msg.sender_jid &&
        prev.from_me === msg.from_me &&
        msg.timestamp - prev.timestamp < 300;
      const showSender = !sameSender;

      // Always resolve from contacts first (user's saved name), fall back to push_name
      const senderName = msg.from_me
        ? "You"
        : props.queries.resolveContactName(msg.sender_jid || msg.chat_jid);

      // Resolve quoted message text
      let quotedText: string | null = null;
      if (msg.quoted_id) {
        const quoted = props.queries.getMessageContent(msg.quoted_id);
        if (quoted?.text) quotedText = quoted.text;
      }

      result.push({ message: msg, showSender, showDate, senderName, quotedText });
    }

    return result;
  });

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={isFocused() ? theme.borderFocused : theme.border}
    >
      <Show
        when={store.selectedChatJid}
        fallback={
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={theme.textMuted}>Select a chat to view messages</text>
          </box>
        }
      >
        <Show
          when={groupedMessages().length > 0}
          fallback={
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <text fg={theme.textMuted}>No messages yet</text>
            </box>
          }
        >
          <scrollbox
            ref={props.scrollRef}
            flexGrow={1}
            stickyScroll
            stickyStart="bottom"
            contentOptions={{ flexGrow: 1 }}
          >
            <For each={groupedMessages()}>
              {(item, idx) => (
                <MessageBubble
                  message={item.message}
                  showSender={item.showSender}
                  showDate={item.showDate}
                  senderName={item.senderName}
                  quotedText={item.quotedText}
                  isSelected={isFocused() && idx() === (groupedMessages().length - 1 - store.selectedMessageIndex)}
                />
              )}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  );
}
