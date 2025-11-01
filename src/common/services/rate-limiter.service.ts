import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface RateLimitConfig {
  points: number;      // Number of requests allowed
  duration: number;    // Time window in seconds
  blockDuration?: number; // Optional block duration if limit exceeded
}

@Injectable()
export class RateLimiterService {
  private readonly redis: Redis;
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD'),
      keyPrefix: 'ratelimit:',
    });

    this.redis.on('error', (err) => {
      this.logger.error('Redis rate limiter error:', err);
    });
  }

  async consume(key: string, config: RateLimitConfig): Promise<{
    success: boolean;
    remainingPoints: number;
    msBeforeNext: number;
  }> {
    const { points, duration, blockDuration } = config;
    const now = Date.now();
    const resultKey = `${key}:${Math.floor(now / (duration * 1000))}`;

    const multi = this.redis.multi();
    multi.incr(resultKey);
    multi.pttl(resultKey);

    try {
      const [consumed, ttl] = await multi.exec() as [
        [Error | null, number],
        [Error | null, number]
      ];

      if (consumed[0]) throw consumed[0];
      if (ttl[0]) throw ttl[0];

      const consumedPoints = consumed[1];
      
      // Set expiration for the first request in a new window
      if (consumedPoints === 1) {
        await this.redis.pexpire(resultKey, duration * 1000);
      }

      const isFirstRequest = consumedPoints === 1;
      const remainingPoints = Math.max(points - consumedPoints, 0);
      const msBeforeNext = isFirstRequest ? duration * 1000 : ttl[1];

      // Block if limit exceeded
      if (consumedPoints > points && blockDuration) {
        await this.redis.set(
          `${key}:blocked`,
          '1',
          'PX',
          blockDuration * 1000
        );
      }

      return {
        success: consumedPoints <= points,
        remainingPoints,
        msBeforeNext,
      };
    } catch (err) {
      this.logger.error(`Rate limiting error for key ${key}:`, err);
      // Fail open - allow request in case of Redis errors
      return {
        success: true,
        remainingPoints: 1,
        msBeforeNext: 0,
      };
    }
  }

  async isBlocked(key: string): Promise<boolean> {
    try {
      return await this.redis.exists(`${key}:blocked`) === 1;
    } catch (err) {
      this.logger.error(`Error checking blocked status for key ${key}:`, err);
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}