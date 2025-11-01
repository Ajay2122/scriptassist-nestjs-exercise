import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface CacheOptions {
  ttl?: number;
  namespace?: string;
}

const DEFAULT_TTL = 300; // 5 minutes

@Injectable()
export class CacheService {
  private readonly redis: Redis;
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD'),
      retryStrategy: (times) => {
        if (times > 3) {
          this.logger.error(`Redis connection failed after ${times} attempts`);
          return null;
        }
        return Math.min(times * 100, 3000);
      },
    });

    this.redis.on('error', (err) => {
      this.logger.error('Redis client error:', err);
    });

    this.redis.on('connect', () => {
      this.logger.log('Successfully connected to Redis');
    });
  }

  private getKey(key: string, namespace?: string): string {
    return namespace ? `${namespace}:${key}` : key;
  }

  async set(key: string, value: any, options: CacheOptions = {}): Promise<void> {
    const { ttl = DEFAULT_TTL, namespace } = options;
    const finalKey = this.getKey(key, namespace);

    try {
      const serializedValue = JSON.stringify(value);
      await this.redis.set(finalKey, serializedValue, 'EX', ttl);
    } catch (error) {
      this.logger.error(`Error setting cache key ${finalKey}:`, error);
      throw error;
    }
  }

  async get<T>(key: string, namespace?: string): Promise<T | null> {
    const finalKey = this.getKey(key, namespace);

    try {
      const value = await this.redis.get(finalKey);
      if (!value) return null;

      return JSON.parse(value) as T;
    } catch (error) {
      this.logger.error(`Error getting cache key ${finalKey}:`, error);
      return null;
    }
  }

  async delete(key: string, namespace?: string): Promise<boolean> {
    const finalKey = this.getKey(key, namespace);

    try {
      const result = await this.redis.del(finalKey);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error deleting cache key ${finalKey}:`, error);
      return false;
    }
  }

  async clear(namespace?: string): Promise<void> {
    try {
      if (namespace) {
        const keys = await this.redis.keys(`${namespace}:*`);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } else {
        await this.redis.flushdb();
      }
    } catch (error) {
      this.logger.error('Error clearing cache:', error);
      throw error;
    }
  }

  async has(key: string, namespace?: string): Promise<boolean> {
    const finalKey = this.getKey(key, namespace);

    try {
      const exists = await this.redis.exists(finalKey);
      return exists === 1;
    } catch (error) {
      this.logger.error(`Error checking cache key ${finalKey}:`, error);
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
      this.logger.log('Redis connection closed gracefully');
    } catch (error) {
      this.logger.error('Error closing Redis connection:', error);
    }
  }

  // Bulk operations
  async mset(keyValues: Record<string, any>, options: CacheOptions = {}): Promise<void> {
    const { ttl = DEFAULT_TTL, namespace } = options;
    const pipeline = this.redis.pipeline();

    try {
      for (const [key, value] of Object.entries(keyValues)) {
        const finalKey = this.getKey(key, namespace);
        const serializedValue = JSON.stringify(value);
        pipeline.set(finalKey, serializedValue, 'EX', ttl);
      }

      await pipeline.exec();
    } catch (error) {
      this.logger.error('Error in bulk set operation:', error);
      throw error;
    }
  }

  async mget<T>(keys: string[], namespace?: string): Promise<(T | null)[]> {
    const finalKeys = keys.map(key => this.getKey(key, namespace));

    try {
      const values = await this.redis.mget(finalKeys);
      return values.map(value => value ? JSON.parse(value) as T : null);
    } catch (error) {
      this.logger.error('Error in bulk get operation:', error);
      return new Array(keys.length).fill(null);
    }
  }

  async getStats(namespace?: string): Promise<{
    totalKeys: number;
    memoryUsage: number;
    hitRate?: number;
  }> {
    try {
      const info = await this.redis.info();
      const keyCount = namespace 
        ? (await this.redis.keys(`${namespace}:*`)).length
        : parseInt(info.match(/keys=(\d+)/)?.[1] || '0');

      return {
        totalKeys: keyCount,
        memoryUsage: parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0'),
        hitRate: parseFloat(info.match(/keyspace_hits:(\d+)/)?.[1] || '0')
      };
    } catch (error) {
      this.logger.error('Error getting cache statistics:', error);
      return {
        totalKeys: 0,
        memoryUsage: 0
      };
    }
  }
} 