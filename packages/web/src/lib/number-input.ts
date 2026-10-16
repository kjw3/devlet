import { useState, type ChangeEvent } from "react";

/**
 * Normalize a number-input draft: digits only, leading zeros stripped
 * (a lone "0" is preserved). Empty input stays empty so the field can be
 * fully cleared; the committed value is then 0 and validation surfaces the
 * minimum instead of an undeletable zero.
 */
export function parseNumericDraft(raw: string): { text: string; value: number } {
  const text = raw.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
  return { text, value: text === "" ? 0 : parseInt(text, 10) };
}

/**
 * Controlled number input that behaves like a text field while editing:
 * the raw text (including empty) stays on screen while the field is focused,
 * and the committed number only feeds back on blur or when changed externally.
 *
 * Fixes the classic "can't delete the 0" bug where value={number} +
 * onChange={Number(e.target.value)} snapped an empty field straight to 0,
 * so typing after it produced "01".
 */
export function useNumberDraft(value: number, onChange: (n: number) => void): {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
} {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    // While focused, show exactly what the user typed (may be empty);
    // otherwise show the committed value.
    value: draft ?? String(value),
    onChange: (e) => {
      const { text, value: n } = parseNumericDraft(e.target.value);
      setDraft(text);
      onChange(n);
    },
    onBlur: () => setDraft(null),
  };
}
