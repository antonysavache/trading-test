import { Injectable } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { Observable, from, of, throwError } from 'rxjs';
import { tap, switchMap, catchError, map } from 'rxjs/operators';
import { IGoogleSheetsService } from '../models/google-sheets.interface';
import { TradingSignal } from '../models/trading-signal.interface';

@Injectable()
export class GoogleSheetsService implements IGoogleSheetsService {
  private auth: JWT | null = null;
  private sheets: sheets_v4.Sheets | null = null;
  private initialized = false;
  private readonly spreadsheetId: string;
  
  constructor() {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_TRADING_SPREADSHEET_ID || '';
  }
  
  initialize(): Observable<void> {
    if (this.initialized) {
      console.log('GoogleSheetsService: Already initialized');
      return of(undefined);
    }
    
    return from(this.initializeSheets()).pipe(
      tap(() => {
        this.initialized = true;
        console.log('GoogleSheetsService: Initialized successfully');
        
        if (!this.spreadsheetId) {
          console.warn('GoogleSheetsService: GOOGLE_SHEETS_TRADING_SPREADSHEET_ID is not set!');
        }
      }),
      catchError(error => {
        console.error('GoogleSheetsService: Initialization failed:', error);
        return throwError(() => error);
      })
    );
  }

  saveTradingSignals(signals: TradingSignal[], sheetName: string = 'page'): Observable<void> {
    if (!signals.length) {
      console.log('GoogleSheetsService: No trading signals to save, returning early');
      return of(undefined);
    }
    
    return this.ensureInitialized().pipe(
      tap(() => console.log(`GoogleSheetsService: Successfully initialized, proceeding to save ${signals.length} trading signals`)),
      switchMap(() => {
        if (!this.spreadsheetId) {
          return throwError(() => new Error('GoogleSheetsService: GOOGLE_SHEETS_TRADING_SPREADSHEET_ID is not set!'));
        }
        
        // Сортируем сигналы по дате (от старых к новым)
        const sortedSignals = [...signals].sort((a, b) => {
          return new Date(a.date).getTime() - new Date(b.date).getTime();
        });
        
        console.log(`GoogleSheetsService: Signals sorted by date. First date: ${sortedSignals[0]?.date}, Last date: ${sortedSignals[sortedSignals.length-1]?.date}`);
        
        // Преобразуем сигналы в формат для записи в таблицу
        // Структура: date | symbol | VP | BTC | Order Book | open | side | tp | sl | result
        const rows = sortedSignals.map(signal => [
          `'${signal.date}`,           // дата как текст
          `'${signal.symbol}`,         // символ как текст  
          signal.VP,                   // VP как boolean
          signal.BTC,                  // BTC как boolean
          signal.orderBook,            // Order Book как boolean
          parseFloat(String(signal.open)) || 0,  // цена входа как число
          `'${signal.side}`,           // сторона как текст
          parseFloat(String(signal.tp)) || 0,    // TP как число
          parseFloat(String(signal.sl)) || 0,    // SL как число
          signal.result !== undefined ? parseFloat(String(signal.result)) || 0 : ''  // результат как число или пустое
        ]);

        const range = `${sheetName}!A:J`;  // столбцы A-J
        
        console.log(`GoogleSheetsService: Appending ${rows.length} rows to spreadsheet ID: ${this.spreadsheetId}, range: ${range}`);
        
        return from(this.sheets!.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: range,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: rows
          }
        })).pipe(
          map(() => {
            console.log(`GoogleSheetsService: Successfully saved ${signals.length} trading signals to ${sheetName}`);
            return undefined as void;
          })
        );
      }),
      catchError(error => {
        console.error(`GoogleSheetsService: Error saving trading signals to sheet ${sheetName}:`, error);
        if (error.response) {
          console.error(`Status: ${error.response.status}, Data:`, error.response.data);
        }
        return throwError(() => error);
      })
    );
  }
  
  saveLog(logEntry: string): Observable<void> {
    console.log(`GoogleSheetsService: Saving log entry: ${logEntry}`);
    
    return this.ensureInitialized().pipe(
      switchMap(() => {
        if (!this.spreadsheetId) {
          return throwError(() => new Error('GoogleSheetsService: No spreadsheet ID configured'));
        }
        
        // Создаем запись лога с текущей датой и временем
        const now = new Date();
        const timestamp = now.toISOString().replace('T', ' ').substring(0, 19); // Формат: YYYY-MM-DD HH:MM:SS
        
        // Форматируем строку для записи
        const row = [
          `'${timestamp}`, // Дата и время как текст
          `'${logEntry}`   // Текст лога как текст
        ];
        
        // Фиксированная страница "logs"
        const range = `logs!A:B`;
        
        return from(this.sheets!.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: range,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [row]
          }
        })).pipe(
          map(() => {
            console.log(`GoogleSheetsService: Log entry saved successfully`);
            return undefined as void;
          })
        );
      }),
      catchError(error => {
        console.error(`GoogleSheetsService: Error saving log:`, error);
        return throwError(() => error);
      })
    );
  }
  
  private ensureInitialized(): Observable<void> {
    if (this.initialized && this.sheets) {
      return of(undefined);
    }
    
    console.log('GoogleSheetsService: Not initialized yet, calling initialize()');
    return this.initialize().pipe(
      tap(() => {
        if (!this.sheets) {
          console.error('GoogleSheetsService: sheets is still null after initialize()!');
        }
      })
    );
  }
  
  private async initializeSheets(): Promise<void> {
    const credentialsStr = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!credentialsStr) {
      throw new Error('GOOGLE_SHEETS_CREDENTIALS environment variable is not set');
    }
    
    try {
      const credentials = JSON.parse(credentialsStr);
      
      console.log(`GoogleSheetsService: Initializing with client_email: ${credentials.client_email}`);
      console.log(`GoogleSheetsService: Using spreadsheet ID: ${this.spreadsheetId}`);
      
      if (!this.spreadsheetId) {
        console.warn('GoogleSheetsService: GOOGLE_SHEETS_TRADING_SPREADSHEET_ID is not set!');
      }
      
      this.auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      
    } catch (error) {
      console.error('GoogleSheetsService: Error parsing credentials or initializing:', error);
      throw error;
    }
  }
}
