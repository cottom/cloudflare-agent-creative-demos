import type { PptTheme } from "./types";

export const PPT_THEMES: Record<PptTheme["id"], PptTheme> = {
  midnight: {
    id: "midnight",
    name: "Midnight Signal",
    background: "0B1020",
    surface: "151C31",
    foreground: "F8FAFC",
    muted: "A7B0C3",
    accent: "7CFFB2",
    fontFamily: "Aptos"
  },
  editorial: {
    id: "editorial",
    name: "Editorial Ink",
    background: "F4F0E8",
    surface: "FFFDFC",
    foreground: "1B1A17",
    muted: "6E6A61",
    accent: "E34B35",
    fontFamily: "Georgia"
  },
  minimal: {
    id: "minimal",
    name: "Minimal Cloud",
    background: "F7F9FC",
    surface: "FFFFFF",
    foreground: "111827",
    muted: "667085",
    accent: "4F46E5",
    fontFamily: "Aptos"
  },
  sunrise: {
    id: "sunrise",
    name: "Sunrise Lab",
    background: "FFF5E9",
    surface: "FFFFFF",
    foreground: "27180E",
    muted: "846F60",
    accent: "FF6B35",
    fontFamily: "Aptos"
  }
};
