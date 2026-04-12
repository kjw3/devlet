import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "Cascadia Code", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        // Mission control palette
        surface: {
          DEFAULT: "#0d0f14",
          raised: "#13161e",
          overlay: "#1a1e2a",
          border: "#252a38",
        },
        accent: {
          cyan: "#00d4ff",
          green: "#00ff88",
          amber: "#ffb800",
          red: "#ff3b5c",
          purple: "#8b5cf6",
        },
        status: {
          provisioning: "#ffb800",
          bootstrapping: "#3b82f6",
          running: "#00ff88",
          idle: "#6b7280",
          terminated: "#374151",
          error: "#ff3b5c",
        },
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        blink: "blink 1s step-end infinite",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
