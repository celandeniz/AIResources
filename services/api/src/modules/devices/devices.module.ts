import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { PhoneTaskService } from './phone-task.service';

@Module({
  controllers: [DevicesController],
  providers: [PhoneTaskService],
  exports: [PhoneTaskService],
})
export class DevicesModule {}
