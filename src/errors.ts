export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string): AppError => new AppError(400, m);
export const unauthorized = (m: string): AppError => new AppError(401, m);
export const forbidden = (m: string): AppError => new AppError(403, m);
export const notFound = (m: string): AppError => new AppError(404, m);
export const conflict = (m: string): AppError => new AppError(409, m);
