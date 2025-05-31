// Простой тест Google Sheets интеграции
const { GoogleSheetsService } = require('./dist/shared/services/google-sheets.service');

async function testGoogleSheets() {
  try {
    console.log('🧪 Тестируем Google Sheets интеграцию...');
    
    const service = new GoogleSheetsService();
    
    console.log('📊 Инициализация сервиса...');
    await new Promise((resolve, reject) => {
      service.initialize().subscribe({
        next: () => {
          console.log('✅ Google Sheets сервис инициализирован');
          resolve();
        },
        error: (err) => {
          console.error('❌ Ошибка инициализации:', err.message);
          reject(err);
        }
      });
    });

    console.log('💾 Сохраняем тестовый сигнал...');
    const testSignal = [{
      date: new Date().toISOString().split('T')[0],
      symbol: 'BTCUSDT',
      VP: true,
      BTC: true,
      orderBook: false,
      open: 45000,
      side: 'long',
      tp: 45900,
      sl: 44100,
    }];

    await new Promise((resolve, reject) => {
      service.saveTradingSignals(testSignal, 'page').subscribe({
        next: () => {
          console.log('✅ Тестовый сигнал сохранен в Google Sheets!');
          resolve();
        },
        error: (err) => {
          console.error('❌ Ошибка сохранения:', err.message);
          reject(err);
        }
      });
    });

    console.log('🎉 Тест завершен успешно!');
    console.log('👀 Проверьте вашу Google Таблицу: https://docs.google.com/spreadsheets/d/1l1KSwngC30Oe8bjuQaBlTSXd4njyyHpNYtsaqCeSO64/edit');

  } catch (error) {
    console.error('💥 Тест провалился:', error.message);
    console.error('🔍 Детали ошибки:', error);
  }
}

// Запускаем тест
testGoogleSheets();
