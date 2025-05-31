import { Controller, Get } from '@nestjs/common';
import { TradingService } from '../modules/trading/trading.service';
import { BTCTrendService } from '../modules/trading/btc-trend.service';

@Controller('trading')
export class TradingController {
  constructor(
    private readonly tradingService: TradingService,
    private readonly btcTrendService: BTCTrendService,
  ) {}

  @Get('stats')
  getTradingStats() {
    return this.tradingService.getTradingStats();
  }

  @Get('positions/open')
  getOpenPositions() {
    return this.tradingService.getOpenPositions();
  }

  @Get('positions/closed')
  getClosedPositions() {
    const positions = this.tradingService.getClosedPositions();
    // Возвращаем последние 50 закрытых позиций
    return positions.slice(-50);
  }

  @Get('positions/summary')
  getPositionsSummary() {
    const stats = this.tradingService.getTradingStats();
    const openPositions = this.tradingService.getOpenPositions();
    const closedPositions = this.tradingService.getClosedPositions();
    const btcTrend = this.btcTrendService.getBTCTrendAnalysis();

    return {
      btcTrend: btcTrend ? {
        trend: btcTrend.trend,
        ema20: btcTrend.ema20,
        ema50: btcTrend.ema50,
        allowLong: btcTrend.allowLong,
        allowShort: btcTrend.allowShort,
        ready: this.btcTrendService.isReady(),
      } : {
        trend: 'NOT_INITIALIZED',
        ready: false,
      },
      summary: {
        totalTrades: stats.totalTrades,
        openTrades: stats.openTrades,
        closedTrades: stats.closedTrades,
        winRate: stats.winRate,
        totalPnl: stats.totalPnl,
        averagePnl: stats.averagePnl,
      },
      openPositions: openPositions.map(pos => ({
        id: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        currentPrice: pos.currentPrice,
        unrealizedPnl: pos.unrealizedPnl,
      })),
      recentClosedTrades: closedPositions.slice(-10).map(pos => ({
        id: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        closedPrice: pos.closedPrice,
        realizedPnl: pos.realizedPnl,
        status: pos.status,
        closeReason: pos.closeReason,
      })),
    };
  }

  @Get('btc-trend')
  getBTCTrend() {
    const analysis = this.btcTrendService.getBTCTrendAnalysis();
    return {
      ...analysis,
      ready: this.btcTrendService.isReady(),
    };
  }
}
