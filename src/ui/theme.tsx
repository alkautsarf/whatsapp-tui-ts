import { createContext, useContext } from "solid-js";

export interface Theme {
  name: string;
  // Backgrounds (undefined = transparent, terminal bg shows through)
  bg: string | undefined;
  bgPanel: string | undefined;
  bgSelected: string;
  bgBubbleOwn: string;
  bgBubbleOther: string;
  bgHover: string;
  bgOverlay: string;
  // Text
  text: string;
  textMuted: string;
  textAccent: string;
  textStrong: string;
  // Borders
  border: string;
  borderFocused: string;
  borderAccent: string;
  // Semantic
  success: string;
  warning: string;
  error: string;
  info: string;
  // Status
  online: string;
  sent: string;
  delivered: string;
  read: string;
  // Mode pills
  modeNormal: string;
  modeInsert: string;
  modeSearch: string;
  // Chat list
  unread: string;
  pin: string;
  // Sender colors (deterministic from JID hash)
  senderColors: string[];
}

export const transparent: Theme = {
  name: "transparent",
  bg: undefined,
  bgPanel: undefined,
  bgSelected: "#2a2a3a",
  bgBubbleOwn: "#1a3a2a",
  bgBubbleOther: "#2a2a3a",
  bgHover: "#252535",
  bgOverlay: "#1a1a2e",
  text: "#d0d0d0",
  textMuted: "#606070",
  textAccent: "#7aa2f7",
  textStrong: "#e0e0e0",
  border: "#3a3a4a",
  borderFocused: "#7aa2f7",
  borderAccent: "#73daca",
  success: "#73daca",
  warning: "#e0af68",
  error: "#f7768e",
  info: "#7aa2f7",
  online: "#73daca",
  sent: "#606070",
  delivered: "#888888",
  read: "#7aa2f7",
  modeNormal: "#7aa2f7",
  modeInsert: "#73daca",
  modeSearch: "#bb9af7",
  unread: "#73daca",
  pin: "#e0af68",
  senderColors: [
    "#7aa2f7", "#f7768e", "#e0af68", "#73daca",
    "#bb9af7", "#ff9e64", "#9ece6a", "#2ac3de",
  ],
};

const ThemeContext = createContext<Theme>(transparent);

export function ThemeProvider(props: { theme?: Theme; children: any }) {
  return (
    <ThemeContext.Provider value={props.theme ?? transparent}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
