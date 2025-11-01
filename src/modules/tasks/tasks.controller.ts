import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, HttpException, HttpStatus } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskFilterDto } from './dto/task-filter.dto';
import { BatchOperationDto } from './dto/batch-operation.dto';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Task } from './entities/task.entity';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginatedResponse } from '../../types/paginated-response.interface';

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(JwtAuthGuard, RateLimitGuard)
@ApiBearerAuth()
export class TasksController {
  constructor(
    private readonly tasksService: TasksService
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  @ApiResponse({ status: 201, description: 'Task successfully created.', type: Task })
  @RateLimit({ limit: 10, windowMs: 60000 }) // More restrictive limit for task creation
  async create(@Body() createTaskDto: CreateTaskDto) {
    return this.tasksService.create(createTaskDto);
  }

  @Get()
  @ApiOperation({ summary: 'Find all tasks with filtering and pagination' })
  @ApiResponse({ status: 200, description: 'Tasks retrieved successfully.' })
  @RateLimit({ limit: 100, windowMs: 60000 }) // Standard limit for listing tasks
  async findAll(@Query() filter: TaskFilterDto): Promise<PaginatedResponse<Task>> {
    return this.tasksService.findAll(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Find one task by id' })
  @ApiResponse({ status: 200, description: 'Task found.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  @RateLimit({ limit: 200, windowMs: 60000 }) // Higher limit for single task lookups
  async findOne(@Param('id') id: string) {
    const task = await this.tasksService.findOne(id);
    if (!task) {
      throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
    }
    return task;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a task' })
  @ApiResponse({ status: 200, description: 'Task successfully updated.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async update(@Param('id') id: string, @Body() updateTaskDto: UpdateTaskDto) {
    return this.tasksService.update(id, updateTaskDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task' })
  @ApiResponse({ status: 200, description: 'Task successfully deleted.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async remove(@Param('id') id: string) {
    return this.tasksService.remove(id);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Perform batch operations on tasks' })
  @ApiResponse({ status: 200, description: 'Batch operation completed successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid operation or task IDs.' })
  async batchOperation(@Body() batchOp: BatchOperationDto) {
    return this.tasksService.executeBatchOperation(batchOp);
  }
}