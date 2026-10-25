declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware from the verified access token. */
      userId?: number;
    }
  }
}
export {};
