import { AnnouncementStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class AnnouncementDraftDto {
  @IsString()
  @Length(1, 160)
  title!: string;

  @IsString()
  @Length(1, 20_000)
  body!: string;
}

export class AnnouncementActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class AnnouncementUpdateDto extends AnnouncementDraftDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class AnnouncementPageQuery {
  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class AdminAnnouncementPageQuery extends AnnouncementPageQuery {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  keyword?: string;

  @IsOptional()
  @IsEnum(AnnouncementStatus)
  status?: AnnouncementStatus;
}
