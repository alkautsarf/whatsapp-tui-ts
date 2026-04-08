// Ambient declaration for `qrcode-terminal` — npm package ships no .d.ts
// and no @types/qrcode-terminal exists on DefinitelyTyped. Loose typing
// matches actual usage in src/wa/client.ts.
declare module "qrcode-terminal" {
  export interface GenerateOptions {
    small?: boolean;
  }
  export function generate(text: string, options?: GenerateOptions): void;
  export function generate(
    text: string,
    options: GenerateOptions,
    callback: (qrcode: string) => void,
  ): void;
  const _default: {
    generate: typeof generate;
  };
  export default _default;
}
