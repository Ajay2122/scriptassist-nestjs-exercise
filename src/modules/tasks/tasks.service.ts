import { Injectable, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Task } from './entities/task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskFilterDto } from './dto/task-filter.dto';
import { BatchOperationDto, BatchOperationType } from './dto/batch-operation.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TaskStatus } from './enums/task-status.enum';
import { PaginatedResponse } from '../../types/paginated-response.interface';
import { CacheService } from '../../common/services/cache.service';
import { TASK_CACHE_PATTERNS } from './constants/cache-keys';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    private readonly cacheService: CacheService,
  ) {}

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    const queryRunner = this.tasksRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = this.tasksRepository.create(createTaskDto);
      const savedTask = await queryRunner.manager.save(task);

      await this.taskQueue.add('task-status-update', {
        taskId: savedTask.id,
        status: savedTask.status,
      }, {
        attempts: 3,
        backoff: 5000
      });

      await queryRunner.commitTransaction();
      
      // Invalidate task list cache since we added a new task
      await this.cacheService.clear('tasks');
      
      return savedTask;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new HttpException(
        'Failed to create task',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(filter: TaskFilterDto): Promise<PaginatedResponse<Task>> {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      priority, 
      userId, 
      search,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'DESC'
    } = filter;

    const cacheKey = `tasks:${JSON.stringify(filter)}`;
    const cached = await this.cacheService.get<PaginatedResponse<Task>>(cacheKey);

    if (cached) {
      return cached;
    }

    const queryBuilder = this.tasksRepository
      .createQueryBuilder('task')
      .leftJoinAndSelect('task.user', 'user')
      .skip((page - 1) * limit)
      .take(limit);

    // Add filters
    if (status) {
      queryBuilder.andWhere('task.status = :status', { status });
    }

    if (priority) {
      queryBuilder.andWhere('task.priority = :priority', { priority });
    }

    if (userId) {
      queryBuilder.andWhere('task.userId = :userId', { userId });
    }

    if (search) {
      queryBuilder.andWhere(
        '(task.title ILIKE :search OR task.description ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    if (startDate) {
      queryBuilder.andWhere('task.createdAt >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('task.createdAt <= :endDate', { endDate });
    }

    // Add sorting
    queryBuilder.orderBy(`task.${sortBy}`, sortOrder);

    // Execute query
    const [items, totalItems] = await queryBuilder.getManyAndCount();

    const totalPages = Math.ceil(totalItems / limit);

    const result = {
      items,
      meta: {
        page,
        limit,
        totalItems,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    };

    await this.cacheService.set(cacheKey, result, { ttl: 60 }); // Cache for 1 minute since task list changes frequently
    return result;
  }

  async findOne(id: string): Promise<Task> {
    const cacheKey = TASK_CACHE_PATTERNS.SINGLE_TASK(id);
    const cached = await this.cacheService.get<Task>(cacheKey);

    if (cached) {
      return cached;
    }

    const task = await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    if (!task) {
      throw new NotFoundException(`Task not found`);
    }

    await this.cacheService.set(cacheKey, task, { ttl: 300 }); // Cache for 5 minutes
    return task;
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    const queryRunner = this.tasksRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await queryRunner.manager.findOne(Task, {
        where: { id },
        relations: ['user'],
      });

      if (!task) {
        throw new NotFoundException(`Task not found`);
      }

      const originalStatus = task.status;
      Object.assign(task, updateTaskDto);
      
      const updatedTask = await queryRunner.manager.save(Task, task);

      if (originalStatus !== updatedTask.status) {
        await this.taskQueue.add('task-status-update', {
          taskId: updatedTask.id,
          status: updatedTask.status,
        }, {
          attempts: 3,
          backoff: 5000
        });
      }

      await queryRunner.commitTransaction();

      // Invalidate both single task and task list caches
      await Promise.all([
        this.cacheService.delete(TASK_CACHE_PATTERNS.SINGLE_TASK(id)),
        this.cacheService.clear('tasks')
      ]);

      return updatedTask;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new HttpException(
        'Failed to update task',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    } finally {
      await queryRunner.release();
    }
  }

  async remove(id: string): Promise<void> {
    const queryRunner = this.tasksRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await queryRunner.manager.findOne(Task, {
        where: { id }
      });

      if (!task) {
        throw new NotFoundException(`Task not found`);
      }

      await queryRunner.manager.remove(Task, task);
      await queryRunner.commitTransaction();

      // Invalidate both single task and task list caches
      await Promise.all([
        this.cacheService.delete(TASK_CACHE_PATTERNS.SINGLE_TASK(id)),
        this.cacheService.clear('tasks')
      ]);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new HttpException(
        'Failed to delete task',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    } finally {
      await queryRunner.release();
    }
  }

  async findByStatus(status: TaskStatus): Promise<Task[]> {
    // Inefficient implementation: doesn't use proper repository patterns
    const query = 'SELECT * FROM tasks WHERE status = $1';
    return this.tasksRepository.query(query, [status]);
  }

  async updateStatus(id: string, status: TaskStatus): Promise<Task> {
    const queryRunner = this.tasksRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await queryRunner.manager.findOne(Task, {
        where: { id }
      });

      if (!task) {
        throw new NotFoundException(`Task not found`);
      }

      task.status = status;
      const updatedTask = await queryRunner.manager.save(Task, task);
      await queryRunner.commitTransaction();
      return updatedTask;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async executeBatchOperation(batchOp: BatchOperationDto): Promise<{ success: true; results: any[] }> {
    const queryRunner = this.tasksRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tasks = await queryRunner.manager.find(Task, {
        where: { id: In(batchOp.taskIds) }
      });

      if (tasks.length !== batchOp.taskIds.length) {
        throw new HttpException(
          'Some tasks were not found',
          HttpStatus.BAD_REQUEST
        );
      }

      const results = [];

      switch (batchOp.operation) {
        case BatchOperationType.UPDATE_STATUS:
          if (!batchOp.status) {
            throw new HttpException(
              'Status is required for status update operation',
              HttpStatus.BAD_REQUEST
            );
          }

          for (const task of tasks) {
            task.status = batchOp.status;
            const updatedTask = await queryRunner.manager.save(Task, task);
            await this.taskQueue.add('task-status-update', {
              taskId: updatedTask.id,
              status: updatedTask.status,
            }, {
              attempts: 3,
              backoff: 5000
            });
            results.push(updatedTask);
          }
          break;

        case BatchOperationType.DELETE:
          await queryRunner.manager.remove(Task, tasks);
          results.push(...tasks.map(t => ({ id: t.id, deleted: true })));
          break;

        default:
          throw new HttpException(
            'Invalid operation type',
            HttpStatus.BAD_REQUEST
          );
      }

      await queryRunner.commitTransaction();

      // Invalidate all affected caches
      await Promise.all([
        ...batchOp.taskIds.map(taskId => 
          this.cacheService.delete(TASK_CACHE_PATTERNS.SINGLE_TASK(taskId))
        ),
        this.cacheService.clear('tasks')
      ]);

      return { success: true, results };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
