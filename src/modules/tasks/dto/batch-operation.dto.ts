import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsUUID } from 'class-validator';
import { TaskStatus } from '../enums/task-status.enum';

export enum BatchOperationType {
  UPDATE_STATUS = 'update_status',
  DELETE = 'delete',
}

export class BatchOperationDto {
  @ApiProperty({ enum: BatchOperationType })
  @IsEnum(BatchOperationType)
  operation: BatchOperationType;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsUUID("4", { each: true })
  taskIds: string[];

  @ApiProperty({ enum: TaskStatus, required: false })
  @IsEnum(TaskStatus)
  status?: TaskStatus;
}