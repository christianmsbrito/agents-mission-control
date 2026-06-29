// Copy to `mission-control.config.ts` (gitignored) and edit.
// Controls the role/category each session is tagged with.
// Precedence: byCwd (first regex match) > byProvider > provider default.

export default {
  categories: {
    byProvider: {
      claude: "code",
      codex: "review",
      hermes: "personal",
      pi: "personal",
      opencode: "code",
    },
    byCwd: [
      { match: /vault/i, category: "vault" },
      { match: /research/i, category: "research" },
    ],
  },
};
