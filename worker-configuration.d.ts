// Minimal Env surface. Prefer `npm run cf-typegen` after first deploy.
interface Ai {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}
