// THE CONTRACT between Kabir (A, /shell) and Aarav (B, /board).
// Change only after telling each other. This file wins over SPEC.md if they disagree.

/** Board is a fixed 800x500 canvas. Points are absolute coordinates on it. */
export type Point = [number, number];

/** Named areas used as default placement for text/formulas when no `at` is given. */
export type Region = "left" | "right" | "top" | "bottom";

export type Action =
  | { type: "draw_line"; id?: string; from: Point; to: Point }
  | { type: "draw_shape"; id: string; shape: "triangle" | "rect" | "circle" | "polygon"; points: Point[]; region?: Region }
  // circle: points[0] = center, points[1] = any point on the edge
  | { type: "write_text"; text: string; at?: Point; region?: Region }
  | { type: "write_formula"; latex: string; at?: Point; region?: Region }
  | { type: "label"; target: string; text: string; at: Point }
  | { type: "highlight"; target: string; part?: "hypotenuse" | "outline"; color?: string }
  | { type: "arrow"; from: Point; to: Point }
  | { type: "erase"; target?: string } // no target = clear everything
  | { type: "draw_svg"; svg: string; region?: Region } // escape hatch for odd topics
  // Helper actions: the board lays these out itself (board/cs-helpers.js, board/flow-helpers.js).
  | { type: "array"; id?: string; values: (string | number)[] } // 1-6 values, up to 6 characters each; boxes get ids <id>-0, <id>-1, ...
  | { type: "flowchart"; source: string }; // Mermaid flowchart source, e.g. "flowchart LR\n A[Rain] --> B[River]"

export interface Step {
  /** What the tutor says out loud for this step. Keep it to 1-2 short sentences. */
  say: string;
  /** What gets drawn WHILE this line is spoken. */
  actions: Action[];
}

export interface Script {
  topic: string;
  steps: Step[];
}

// ---- Provided by Kabir (A) ----
/** Speak text out loud. Resolves when the audio has finished. */
export type Speak = (text: string) => Promise<void>;

// ---- Provided by Aarav (B) ----
/**
 * Plays one step: starts speak(step.say) and the drawing at the same moment,
 * resolves only when BOTH are done.
 */
export type PlayStep = (step: Step, speak: Speak) => Promise<void>;
export type PlayScript = (script: Script, speak: Speak) => Promise<void>;
/** JSON-serialisable snapshot of what is on the board (sent back to the AI on follow-ups). */
export type GetBoardState = () => unknown;
export type ClearBoard = () => void;

// Streaming note: the AI may stream one Step per line (NDJSON): first line {"topic": "..."},
// then one {"say": ..., "actions": [...]} per line, so step 1 can play within ~3 seconds.
