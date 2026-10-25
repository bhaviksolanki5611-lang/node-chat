import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { requestLogger } from './logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { globalLimiter } from './middleware/rateLimit';
import { authRouter } from './routes/auth';
import { chatRouter } from './routes/chat';
import { healthRouter } from './routes/health';
import { userRouter } from './routes/user';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);

app.use(requestLogger);
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false }));
app.use(compression());
app.use(express.json({ limit: '32kb' }));

app.use('/health', healthRouter); // before rate limiting so probes are never throttled
app.use(globalLimiter);
app.use('/auth', authRouter);
app.use('/chat', chatRouter);
app.use('/user', userRouter);

app.use(notFoundHandler);
app.use(errorHandler);
