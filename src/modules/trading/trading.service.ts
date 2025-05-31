import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
  TradingPosition, 
  TradingSignal, 
  TradingStats, 
  TradingConfig 
} from '../../interfaces/trading.interface';
import { SidewaysPattern } from '../../interfaces/analysis.interface';
import { BTCTrendService } from './btc-trend.service';
import { OrderBookAnalysisService } from '../analysis/orderbook-analysis.service';
import { SignalService, TradingSignal as GoogleSheetsSignal } from '../../shared';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);
  private readonly config: TradingConfig;
  
  // Активные позиции
  private readonly openPositions: Map<string, TradingPosition> = new Map();
  
  // История закрытых позиций
  private readonly closedPositions: TradingPosition[] = [];
  
  // Статистика
  private stats: TradingStats = {
    totalTrades: 0,
    openTrades: 0,
    closedTrades: 0,
    winTrades: 0,
    lossTrades: 0,
    winRate: 0,
    totalPnl: 0,
    averagePnl: 0,
    maxWin: 0,
    maxLoss: 0,
  };

  constructor(
    private configService: ConfigService,
    private btcTrendService: BTCTrendService,
    private orderBookService: OrderBookAnalysisService,
    private signalService: SignalService,
  ) {
    this.config = {
      enabled: this.configService.get<boolean>('trading.enabled', true),
      takeProfitPercent: this.configService.get<number>('trading.takeProfitPercent', 2.0), // 2%
      stopLossPercent: this.configService.get<number>('trading.stopLossPercent', 2.0), // 2% (равно ТП)
      maxPositionsPerSymbol: this.configService.get<number>('trading.maxPositionsPerSymbol', 1),
      maxTotalPositions: this.configService.get<number>('trading.maxTotalPositions', 10),
    };
    
    this.logger.log(`Trading Service инициализирован: TP=${this.config.takeProfitPercent}%, SL=${this.config.stopLossPercent}%`);
  }

  /**
   * Создает торговый сигнал на основе найденного бокового движения
   * 🆕 НОВАЯ ЛОГИКА: Входим во ВСЕ боковики, но отмечаем подтверждения фильтрами
   */
  async processSidewaysPattern(pattern: SidewaysPattern, currentPrice: number): Promise<TradingSignal | null> {
    if (!this.config.enabled) {
      return null;
    }

    // Проверяем лимиты позиций
    if (!this.canOpenPosition(pattern.symbol)) {
      this.logger.debug(`${pattern.symbol}: Превышен лимит позиций`);
      return null;
    }

    // Определяем направление сделки на основе паттерна
    let direction: 'LONG' | 'SHORT';
    let reason: string;
    
    if (pattern.direction === 'low_to_high_to_low') {
      direction = 'LONG';
      reason = `Боковик завершен возвратом к низу (${pattern.startPrice.toFixed(6)} → ${pattern.middlePrice.toFixed(6)} → ${currentPrice.toFixed(6)})`;
    } else {
      direction = 'SHORT';
      reason = `Боковик завершен возвратом к верху (${pattern.startPrice.toFixed(6)} → ${pattern.middlePrice.toFixed(6)} → ${currentPrice.toFixed(6)})`;
    }

    // 🔥 ПРОВЕРЯЕМ ПРОТИВОПОЛОЖНУЮ ПОЗИЦИЮ
    const existingPosition = this.getPositionBySymbol(pattern.symbol);
    if (existingPosition && existingPosition.direction !== direction) {
      this.closePositionByReversal(existingPosition, currentPrice, `Смена тренда: ${existingPosition.direction} → ${direction}`);
      this.logger.log(
        `🔄 СМЕНА НАПРАВЛЕНИЯ [${existingPosition.direction} → ${direction}] ${pattern.symbol} | ` +
        `Старая позиция закрыта по цене ${currentPrice.toFixed(6)}`
      );
    }

    // 🆕 НОВАЯ ЛОГИКА: Проверяем подтверждения, но НЕ блокируем сделку
    const confirmation = {
      btcTrend: false,
      volumeProfile: true, // У нас есть боковое движение = volume profile подтверждение
      overall: false
    };

    const confirmationDetails: string[] = [];

    // 1. Проверяем BTC тренд для подтверждения
    const btcTrendAnalysis = this.btcTrendService.getBTCTrendAnalysis();
    if (this.btcTrendService.isDirectionAllowed(direction)) {
      confirmation.btcTrend = true;
      confirmationDetails.push(`✅ BTC ${btcTrendAnalysis?.trend || 'UNKNOWN'}`);
    } else {
      confirmation.btcTrend = false;
      confirmationDetails.push(`❌ BTC ${btcTrendAnalysis?.trend || 'UNKNOWN'}`);
    }

    // 2. Проверяем Order Book для подтверждения (не блокируем, только отмечаем)
    let orderBookConfirmed = false;
    try {
      const orderBookAnalysis = await this.orderBookService.getOrderBookAnalysis(pattern.symbol);
      orderBookConfirmed = this.orderBookService.isDirectionSupported(direction, orderBookAnalysis);
      
      if (orderBookConfirmed) {
        confirmationDetails.push(`✅ OrderBook (${orderBookAnalysis.bidAskRatio.toFixed(2)})`);
      } else {
        confirmationDetails.push(`❌ OrderBook (${orderBookAnalysis.bidAskRatio.toFixed(2)})`);
      }
    } catch (error) {
      confirmationDetails.push(`⚠️ OrderBook недоступен`);
    }

    // 3. Общее подтверждение - если все фильтры подтверждают
    confirmation.overall = confirmation.btcTrend && confirmation.volumeProfile && orderBookConfirmed;

    // Рассчитываем уровни TP и SL
    const takeProfitPrice = direction === 'LONG' 
      ? currentPrice * (1 + this.config.takeProfitPercent / 100)
      : currentPrice * (1 - this.config.takeProfitPercent / 100);
      
    const stopLossPrice = direction === 'LONG'
      ? currentPrice * (1 - this.config.stopLossPercent / 100)
      : currentPrice * (1 + this.config.stopLossPercent / 100);

    const signal: TradingSignal = {
      symbol: pattern.symbol,
      direction,
      entryPrice: currentPrice,
      timestamp: Date.now(),
      reason: `${reason} | Подтверждения: ${confirmationDetails.join(', ')}`,
      takeProfitPrice: Number(takeProfitPrice.toFixed(8)),
      stopLossPrice: Number(stopLossPrice.toFixed(8)),
      sidewaysPattern: pattern,
      confirmation: confirmation, // 🆕 Добавляем поле подтверждения
    };

    // 🆕 НОВАЯ ЛОГИКА: Логируем с информацией о подтверждениях
    const confirmIcon = confirmation.overall ? '🟢' : '🟡';
    this.logger.log(
      `${confirmIcon} СИГНАЛ СОЗДАН [${direction}] ${pattern.symbol} | ` +
      `Подтверждений: ${confirmationDetails.join(' | ')}`
    );

    return signal;
  }

  /**
   * Открывает позицию по сигналу
   */
  openPosition(signal: TradingSignal): TradingPosition {
    const position: TradingPosition = {
      id: uuidv4(),
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      entryTime: signal.timestamp,
      currentPrice: signal.entryPrice,
      takeProfitPrice: signal.takeProfitPrice,
      stopLossPrice: signal.stopLossPrice,
      status: 'OPEN',
      unrealizedPnl: 0,
      triggerReason: signal.reason,
      confirmation: signal.confirmation, // 🆕 Сохраняем информацию о подтверждениях
    };

    this.openPositions.set(position.id, position);
    this.stats.totalTrades++;
    this.stats.openTrades++;
    
    // 🆕 Отображаем иконку в зависимости от подтверждений
    const confirmIcon = position.confirmation.overall ? '🟢' : '🟡';
    const confirmText = position.confirmation.overall ? 'ПОЛНОЕ ПОДТВЕРЖДЕНИЕ' : 'ЧАСТИЧНОЕ ПОДТВЕРЖДЕНИЕ';
    
    this.logger.log(`🔥 ${confirmIcon} ПОЗИЦИЯ ОТКРЫТА [${position.direction}] ${position.symbol} по ${this.formatPrice(position.entryPrice)} | ${confirmText}`);
    this.logger.log(`📊 TP: ${this.formatPrice(position.takeProfitPrice)} | SL: ${this.formatPrice(position.stopLossPrice)}`);
    this.logger.log(`📋 Подтверждения: BTC=${position.confirmation.btcTrend ? '✅' : '❌'} | VP=✅ | OrderBook=${position.confirmation.volumeProfile ? '✅' : '❌'}`);

    // 🆕 Сохраняем торговый сигнал в Google Sheets
    this.saveSignalToGoogleSheets(signal, position);

    return position;
  }

  /**
   * Обновляет все открытые позиции текущими ценами
   */
  updatePositions(symbol: string, currentPrice: number): void {
    const symbolPositions = Array.from(this.openPositions.values())
      .filter(pos => pos.symbol === symbol && pos.status === 'OPEN');

    for (const position of symbolPositions) {
      this.updatePosition(position, currentPrice);
    }
  }

  /**
   * Обновляет конкретную позицию
   */
  private updatePosition(position: TradingPosition, currentPrice: number): void {
    const oldPrice = position.currentPrice;
    position.currentPrice = currentPrice;

    // Рассчитываем PnL
    if (position.direction === 'LONG') {
      position.unrealizedPnl = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    } else {
      position.unrealizedPnl = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
    }

    // Проверяем условия закрытия
    let shouldClose = false;
    let closeReason = '';

    // Проверка тейк-профита
    if (position.direction === 'LONG' && currentPrice >= position.takeProfitPrice) {
      shouldClose = true;
      closeReason = 'Take Profit достигнут';
      position.status = 'CLOSED_TP';
    } else if (position.direction === 'SHORT' && currentPrice <= position.takeProfitPrice) {
      shouldClose = true;
      closeReason = 'Take Profit достигнут';
      position.status = 'CLOSED_TP';
    }

    // Проверка стоп-лосса
    if (position.direction === 'LONG' && currentPrice <= position.stopLossPrice) {
      shouldClose = true;
      closeReason = 'Stop Loss сработал';
      position.status = 'CLOSED_SL';
    } else if (position.direction === 'SHORT' && currentPrice >= position.stopLossPrice) {
      shouldClose = true;
      closeReason = 'Stop Loss сработал';
      position.status = 'CLOSED_SL';
    }

    // Закрываем позицию если нужно
    if (shouldClose) {
      this.closePosition(position, currentPrice, closeReason);
    } else {
      // Логируем изменение PnL только если цена значительно изменилась
      const priceChangePercent = Math.abs((currentPrice - oldPrice) / oldPrice) * 100;
      if (priceChangePercent > 0.1) { // Если изменение больше 0.1%
        this.logger.debug(`💹 ${position.symbol} [${position.direction}] PnL: ${position.unrealizedPnl.toFixed(2)}% | Цена: ${this.formatPrice(currentPrice)}`);
      }
    }
  }

  /**
   * Закрывает позицию
   */
  private closePosition(position: TradingPosition, closePrice: number, reason: string): void {
    position.closedPrice = closePrice;
    position.closedTime = Date.now();
    position.closeReason = reason;
    position.realizedPnl = position.unrealizedPnl;

    // Обновляем статистику
    this.stats.openTrades--;
    this.stats.closedTrades++;
    
    if (position.realizedPnl > 0) {
      this.stats.winTrades++;
      if (position.realizedPnl > this.stats.maxWin) {
        this.stats.maxWin = position.realizedPnl;
      }
    } else {
      this.stats.lossTrades++;
      if (position.realizedPnl < this.stats.maxLoss) {
        this.stats.maxLoss = position.realizedPnl;
      }
    }

    this.stats.totalPnl += position.realizedPnl;
    this.stats.winRate = (this.stats.winTrades / this.stats.closedTrades) * 100;
    this.stats.averagePnl = this.stats.totalPnl / this.stats.closedTrades;

    // Переносим в историю
    this.closedPositions.push({ ...position });
    this.openPositions.delete(position.id);

    const emoji = position.status === 'CLOSED_TP' ? '✅' : '❌';
    const pnlColor = position.realizedPnl > 0 ? '+' : '';
    
    this.logger.log(`${emoji} ПОЗИЦИЯ ЗАКРЫТА [${position.direction}] ${position.symbol} | ${pnlColor}${position.realizedPnl.toFixed(2)}% | ${reason}`);
    this.logger.log(`📈 Вход: ${this.formatPrice(position.entryPrice)} → Выход: ${this.formatPrice(closePrice)}`);
    
    // 🆕 Обновляем результат в Google Sheets
    this.updateSignalResultInGoogleSheets(position);
    
    // Логируем статистику каждые 5 закрытых сделок
    if (this.stats.closedTrades % 5 === 0) {
      this.logTradingStats();
    }
  }

  /**
   * Проверяет, можно ли открыть позицию для символа
   */
  private canOpenPosition(symbol: string): boolean {
    const symbolPositions = Array.from(this.openPositions.values())
      .filter(pos => pos.symbol === symbol).length;
    
    // Убрали проверку общего лимита позиций - теперь лимит только по символу
    return symbolPositions < this.config.maxPositionsPerSymbol;
  }

  /**
   * Возвращает статистику торговли
   */
  getTradingStats(): TradingStats {
    return { ...this.stats };
  }

  /**
   * Логирует текущую статистику
   */
  logTradingStats(): void {
    this.logger.log(`📊 СТАТИСТИКА ТОРГОВЛИ:`);
    this.logger.log(`   Всего сделок: ${this.stats.totalTrades} | Открыто: ${this.stats.openTrades} | Закрыто: ${this.stats.closedTrades}`);
    if (this.stats.closedTrades > 0) {
      this.logger.log(`   Выигрышных: ${this.stats.winTrades} | Проигрышных: ${this.stats.lossTrades} | Win Rate: ${this.stats.winRate.toFixed(1)}%`);
      this.logger.log(`   Общий PnL: ${this.stats.totalPnl.toFixed(2)}% | Средний PnL: ${this.stats.averagePnl.toFixed(2)}%`);
      this.logger.log(`   Лучшая сделка: +${this.stats.maxWin.toFixed(2)}% | Худшая: ${this.stats.maxLoss.toFixed(2)}%`);
    }
  }

  /**
   * Возвращает все открытые позиции
   */
  getOpenPositions(): TradingPosition[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Возвращает историю закрытых позиций
   */
  getClosedPositions(): TradingPosition[] {
    return [...this.closedPositions];
  }

  /**
   * Возвращает позицию по символу (если есть)
   */
  getPositionBySymbol(symbol: string): TradingPosition | null {
    const positions = Array.from(this.openPositions.values()).filter(pos => pos.symbol === symbol);
    return positions.length > 0 ? positions[0] : null;
  }

  /**
   * Возвращает позиции по символу
   */
  getPositionsBySymbol(symbol: string): TradingPosition[] {
    return Array.from(this.openPositions.values()).filter(pos => pos.symbol === symbol);
  }

  /**
   * Закрывает позицию при смене тренда
   */
  private closePositionByReversal(position: TradingPosition, closePrice: number, reason: string): void {
    position.closedPrice = closePrice;
    position.closedTime = Date.now();
    position.closeReason = reason;
    position.status = 'CLOSED_SL'; // Помечаем как закрытую по внешней причине
    
    // Рассчитываем финальный PnL
    if (position.direction === 'LONG') {
      position.realizedPnl = ((closePrice - position.entryPrice) / position.entryPrice) * 100;
    } else {
      position.realizedPnl = ((position.entryPrice - closePrice) / position.entryPrice) * 100;
    }
    
    position.unrealizedPnl = position.realizedPnl;

    // Обновляем статистику
    this.stats.openTrades--;
    this.stats.closedTrades++;
    
    if (position.realizedPnl > 0) {
      this.stats.winTrades++;
      if (position.realizedPnl > this.stats.maxWin) {
        this.stats.maxWin = position.realizedPnl;
      }
    } else {
      this.stats.lossTrades++;
      if (position.realizedPnl < this.stats.maxLoss) {
        this.stats.maxLoss = position.realizedPnl;
      }
    }

    this.stats.totalPnl += position.realizedPnl;
    this.stats.winRate = this.stats.closedTrades > 0 ? (this.stats.winTrades / this.stats.closedTrades) * 100 : 0;
    this.stats.averagePnl = this.stats.closedTrades > 0 ? this.stats.totalPnl / this.stats.closedTrades : 0;

    // Переносим в историю
    this.closedPositions.push({ ...position });
    this.openPositions.delete(position.id);

    const emoji = position.realizedPnl > 0 ? '🔄✅' : '🔄❌';
    const pnlColor = position.realizedPnl > 0 ? '+' : '';
    
    this.logger.log(`${emoji} ПОЗИЦИЯ ЗАКРЫТА ПО СМЕНЕ ТРЕНДА [${position.direction}] ${position.symbol} | ${pnlColor}${position.realizedPnl.toFixed(2)}% | ${reason}`);
    this.logger.log(`📈 Вход: ${this.formatPrice(position.entryPrice)} → Выход: ${this.formatPrice(closePrice)}`);
    
    // 🆕 Обновляем результат в Google Sheets
    this.updateSignalResultInGoogleSheets(position);
  }

  /**
   * Сохраняет торговый сигнал в Google Sheets
   */
  private async saveSignalToGoogleSheets(signal: TradingSignal, position: TradingPosition): Promise<void> {
    try {
      const googleSheetsSignal: GoogleSheetsSignal = {
        date: new Date().toISOString().split('T')[0], // Текущая дата в формате YYYY-MM-DD
        symbol: signal.symbol,
        VP: signal.confirmation.volumeProfile, // Volume Profile подтверждение
        BTC: signal.confirmation.btcTrend, // BTC тренд подтверждение
        orderBook: signal.confirmation.overall, // Общее подтверждение (включая OrderBook)
        open: signal.entryPrice,
        side: signal.direction.toLowerCase() as 'long' | 'short',
        tp: signal.takeProfitPrice,
        sl: signal.stopLossPrice,
      };

      await this.signalService.createTradingSignal(googleSheetsSignal, 'page');
      
      const confirmStatus = signal.confirmation.overall ? '🟢 ПОЛНОЕ' : '🟡 ЧАСТИЧНОЕ';
      this.logger.log(`📊 Торговый сигнал сохранен в Google Sheets: ${signal.symbol} ${signal.direction} | ${confirmStatus} подтверждение`);
    } catch (error) {
      this.logger.error(`❌ Ошибка сохранения сигнала в Google Sheets: ${error.message}`);
    }
  }

  /**
   * Обновляет результат торгового сигнала в Google Sheets при закрытии позиции
   */
  private async updateSignalResultInGoogleSheets(position: TradingPosition): Promise<void> {
    try {
      const googleSheetsSignal: GoogleSheetsSignal = {
        date: new Date(position.entryTime).toISOString().split('T')[0], // Дата входа
        symbol: position.symbol,
        VP: position.confirmation.volumeProfile, // Volume Profile подтверждение
        BTC: position.confirmation.btcTrend, // BTC тренд подтверждение
        orderBook: position.confirmation.overall, // Общее подтверждение (включая OrderBook)
        open: position.entryPrice,
        side: position.direction.toLowerCase() as 'long' | 'short',
        tp: position.takeProfitPrice,
        sl: position.stopLossPrice,
        result: position.realizedPnl, // Результат в процентах
      };

      await this.signalService.updateTradingSignalResult(googleSheetsSignal, 'page');
      
      const pnlIcon = (position.realizedPnl ?? 0) > 0 ? '✅' : '❌';
      const confirmStatus = position.confirmation.overall ? '🟢' : '🟡';
      this.logger.log(`📊 ${pnlIcon} Результат обновлен в Google Sheets: ${position.symbol} ${position.realizedPnl?.toFixed(2)}% | ${confirmStatus}`);
    } catch (error) {
      this.logger.error(`❌ Ошибка обновления результата в Google Sheets: ${error.message}`);
    }
  }

  /**
   * Форматирует цену для отображения
   */
  private formatPrice(price: number): string {
    if (price >= 1000) {
      return price.toFixed(2);
    } else if (price >= 1) {
      return price.toFixed(4);
    } else if (price >= 0.01) {
      return price.toFixed(6);
    } else {
      return price.toFixed(8);
    }
  }
}
