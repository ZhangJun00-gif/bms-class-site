import { Module } from '@nestjs/common';
import { AlbumsController } from './albums.controller';
import { AlbumOriginalExportService } from './album-original-export.service';

@Module({ controllers: [AlbumsController], providers: [AlbumOriginalExportService] })
export class AlbumsModule {}
