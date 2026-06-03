import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

export function zodMiddleware<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'validation_error',
        issues: result.error.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
