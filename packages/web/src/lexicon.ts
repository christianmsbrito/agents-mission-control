import { createContext, useContext } from "react";
import type { Skin } from "./prefs.ts";

// A theme is a LANGUAGE, not just a palette. Each skin supplies a Lexicon — the
// terminology shown across the UI — so switching themes re-words the whole app
// (FF "heroes/quests/gil" ↔ Terminal "processes/jobs/credits"). Components read
// terms via useLex(); nothing user-facing should hardcode flavor words.

export type Lexicon = {
  // nav (view labels)
  nav: { party: string; dashboard: string; quests: string; records: string };

  // core nouns
  hero: string; heroes: string;      // one session / many
  quest: string; quests: string;     // a work item
  gil: string; gilGlyph: string;     // cost unit + glyph
  realm: string; realms: string;     // host
  klass: string; classes: string;    // provider-as-class
  skill: string; skills: string;     // a tool
  level: string;                     // "Lv"
  hp: string; xp: string;            // the two bars

  // dashboard
  partyStatus: string;               // panel title
  spent: string;                     // spend chart title (suffixed " · 14 days")
  leaderboard: string;               // leaderboard title
  stat: {                            // stat tile captions
    heroes: string; inBattle: string; awaiting: string; idle: string; ko: string;
    gilRate: string; realms: string; classes: string; quests: string;
  };

  // status (live) + fate (history)
  state: { battle: string; awaiting: string; ko: string; resting: string };
  fate: { running: string; closed: string; orphaned: string };

  // suggested action shown in the warn balloon when a hero is KO/crashed
  crash: { reauth: string; model: string; transient: string; connection: string; context: string; generic: string };

  // quest board columns
  questBoard: { active: string; backlog: string; done: string; empty: string; hint: string };

  // empty states
  partyRestsTitle: string; partyRestsNone: string; partyRestsFiltered: string;
  recordsEmpty: string;

  // character sheet sections
  sheet: {
    attributes: string; questLog: string; saga: string; inventory: string;
    chronicle: string; summoning: string; notFound: string; noDeeds: string;
    xpTokens: string;
  };

  // search placeholders
  seekPlaceholder: string; archivePlaceholder: string;

  // card
  noQuest: string; speakPlaceholder: string;

  // facet group labels
  facet: { klass: string; role: string; realm: string; fate: string };

  // provider → class/job name
  jobs: Record<string, string>;
  jobFallback: string;
};

const ff: Lexicon = {
  nav: { party: "party", dashboard: "war table", quests: "quests", records: "records" },
  hero: "hero", heroes: "heroes",
  quest: "quest", quests: "quests",
  gil: "gil", gilGlyph: "⛁",
  realm: "realm", realms: "realms",
  klass: "class", classes: "classes",
  skill: "skill", skills: "skills",
  level: "Lv",
  hp: "HP", xp: "XP",
  partyStatus: "Party Status",
  spent: "Gil spent",
  leaderboard: "Richest heroes",
  stat: { heroes: "heroes", inBattle: "in battle", awaiting: "awaiting", idle: "resting", ko: "KO",
    gilRate: "gil/hr", realms: "realms", classes: "classes", quests: "quests" },
  state: { battle: "In battle", awaiting: "Awaiting orders", ko: "KO", resting: "Resting" },
  fate: { running: "On campaign", closed: "Retired", orphaned: "Lost" },
  crash: {
    reauth: "Renew your sigil (/login), then rally.",
    model: "Choose a worthy weapon (/model), then rally.",
    transient: "The ether falters — wait a moment and rally.",
    connection: "The link was severed — rally to resume.",
    context: "The tome is full — compact or start anew.",
    generic: "Felled — check the hero and rally.",
  },
  questBoard: { active: "Active quests", backlog: "Quest log", done: "Vanquished",
    empty: "No quests posted", hint: "Claude/OpenClaw TodoWrite lists appear here as quests." },
  partyRestsTitle: "The party rests",
  partyRestsNone: "No heroes are afield right now.",
  partyRestsFiltered: "No heroes match your filters.",
  recordsEmpty: "No records found",
  sheet: { attributes: "Attributes", questLog: "Quest log", saga: "Saga (time-series)",
    inventory: "Inventory", chronicle: "Chronicle", summoning: "Summoning…",
    notFound: "Hero not found", noDeeds: "No recorded deeds.", xpTokens: "XP (tokens)" },
  seekPlaceholder: "seek a hero — name, class, quest, tool…",
  archivePlaceholder: "search the archive — name, quest, realm…",
  noQuest: "No active quest",
  speakPlaceholder: "speak to this hero…",
  facet: { klass: "class", role: "role", realm: "realm", fate: "fate" },
  jobs: { claude: "Sage", codex: "Knight", opencode: "Ranger", pi: "Cleric", hermes: "Bard", openclaw: "Berserker" },
  jobFallback: "Wanderer",
};

const terminal: Lexicon = {
  nav: { party: "processes", dashboard: "metrics", quests: "jobs", records: "logs" },
  hero: "process", heroes: "processes",
  quest: "job", quests: "jobs",
  gil: "credits", gilGlyph: "₵",
  realm: "host", realms: "hosts",
  klass: "kind", classes: "kinds",
  skill: "op", skills: "ops",
  level: "lvl",
  hp: "CTX", xp: "OPS",
  partyStatus: "System Status",
  spent: "Spend",
  leaderboard: "Top consumers",
  stat: { heroes: "procs", inBattle: "running", awaiting: "blocked", idle: "idle", ko: "crashed",
    gilRate: "cost/hr", realms: "hosts", classes: "kinds", quests: "jobs" },
  state: { battle: "RUNNING", awaiting: "BLOCKED", ko: "CRASHED", resting: "IDLE" },
  fate: { running: "ACTIVE", closed: "EXITED", orphaned: "ORPHANED" },
  crash: {
    reauth: "Re-authenticate (/login), then resume.",
    model: "Pick a valid model (/model), then resume.",
    transient: "Transient — wait a moment and resume.",
    connection: "Connection dropped — resume.",
    context: "Context full — compact or start fresh.",
    generic: "Crashed — check the session and resume.",
  },
  questBoard: { active: "Running", backlog: "Queued", done: "Done",
    empty: "No jobs queued", hint: "Claude/OpenClaw TodoWrite lists appear here as jobs." },
  partyRestsTitle: "No processes",
  partyRestsNone: "No processes running right now.",
  partyRestsFiltered: "No processes match the filter.",
  recordsEmpty: "No logs found",
  sheet: { attributes: "Stats", questLog: "Job queue", saga: "Telemetry",
    inventory: "Syscalls", chronicle: "Log", summoning: "Loading…",
    notFound: "Process not found", noDeeds: "No log entries.", xpTokens: "OPS (tokens)" },
  seekPlaceholder: "grep processes — name, kind, job, op…",
  archivePlaceholder: "grep the logs — name, job, host…",
  noQuest: "No active job",
  speakPlaceholder: "write to stdin…",
  facet: { klass: "kind", role: "role", realm: "host", fate: "state" },
  jobs: { claude: "Daemon", codex: "Builder", opencode: "Editor", pi: "Inference", hermes: "Bus", openclaw: "Worker" },
  jobFallback: "Process",
};

export const LEXICONS: Record<Skin, Lexicon> = { ff, terminal };

export const LexiconContext = createContext<Lexicon>(ff);
export const useLex = (): Lexicon => useContext(LexiconContext);
