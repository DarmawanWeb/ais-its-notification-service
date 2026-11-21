import { PageQueryDto } from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** Query of `GET /alert-rules` (page-based list, spec §5). */
export class ListAlertRulesQuery extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Organization (super_admin; others: their own)' })
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  readonly enabled?: boolean;
}
