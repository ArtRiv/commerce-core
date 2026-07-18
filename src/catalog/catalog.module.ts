import { Module } from '@nestjs/common';

import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockService } from './stock.service';

/**
 * Products, categories and stock. Exports are the module's contract with
 * `orders` (docs/architecture/modules.md): ProductsService to read what is
 * being bought, StockService.decrement to take the units — orders never
 * touches the catalog's tables directly.
 */
@Module({
  controllers: [ProductsController, CategoriesController],
  providers: [ProductsService, CategoriesService, StockService],
  exports: [ProductsService, StockService],
})
export class CatalogModule {}
