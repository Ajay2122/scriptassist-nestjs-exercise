import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { RateLimiterService } from '../services/rate-limiter.service';
import { RATE_LIMIT_KEY, RateLimitOptions } from '../decorators/rate-limit.decorator';
import { createHash } from 'crypto';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private rateLimiterService: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const rateLimit = this.getRateLimitConfig(context);
    
    if (!rateLimit) {
      return true; // No rate limit configured
    }

    const key = this.generateKey(request);

    // Check if the client is blocked
    const isBlocked = await this.rateLimiterService.isBlocked(key);
    if (isBlocked) {
      throw new HttpException({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests. Please try again later.'
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const result = await this.rateLimiterService.consume(key, {
      points: rateLimit.limit,
      duration: rateLimit.windowMs / 1000,
      blockDuration: 60 // Block for 1 minute if limit exceeded
    });

    // Set rate limit headers
    const response = context.switchToHttp().getResponse();
    response.header('X-RateLimit-Limit', rateLimit.limit);
    response.header('X-RateLimit-Remaining', result.remainingPoints);
    response.header('X-RateLimit-Reset', new Date(Date.now() + result.msBeforeNext).toISOString());

    if (!result.success) {
      throw new HttpException({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(result.msBeforeNext / 1000)
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }

  private getRateLimitConfig(context: ExecutionContext): RateLimitOptions | null {
    const defaultLimit = 100;
    const defaultWindowMs = 60000; // 1 minute

    const rateLimit = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!rateLimit) {
      return null;
    }

    return {
      limit: rateLimit.limit || defaultLimit,
      windowMs: rateLimit.windowMs || defaultWindowMs
    };
  }

  private generateKey(request: any): string {
    const ip = request.ip;
    const userAgent = request.headers['user-agent'] || '';
    const path = request.route?.path || request.url;
    
    // Create a hash of the IP and User-Agent to anonymize the data
    const hash = createHash('sha256')
      .update(`${ip}:${userAgent}:${path}`)
      .digest('hex');

    return hash;
  }
} 