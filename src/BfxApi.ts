import * as WebSocket from 'ws';
import * as config from '../config.json';
import ActionsStack from './ActionsStack';
import Expectations, { MatchFunc } from './Expectations';

const allowedVersions = config.BitfinexAPIVersions;
const bfxAPI = config.BitfinexDefaultAPIUrl;

function MatchHeartbeat(chanId: number): MatchFunc {
  return (msg: any[]) => msg[0] === chanId && msg[1] === 'hb';
}

function MatchSnapshot(chanId: number): MatchFunc {
  return (msg: any[]) => msg[0] === chanId && msg[1] !== 'hb';
}

export type SnapshotCallback = (msg: Array<number|string>) => void;

export type wsOnOpen = (this: WebSocket, ev: { target: WebSocket } | Event) => any;
export interface IBfxApiParameters {
  apiKey?: string;
  apiSecret?: string;
  logger?: Console;
  url?: string;
  WebSocket?: typeof WebSocket;
}

const defaultBfxApiParameters = {
  logger: console,
  url: bfxAPI,
};

type voidFunction = (...p: any[]) => void;

interface IMsgInfo {
  code: number;
}

export interface ISubscribeEvent {
  chanId: number;
  channel: string;
  event: string;
  pair?: string;
  symbol?: string;
}

export interface IUnsubscribeEvent {
  chanId: number;
  event: string;
}

interface ISubscribeParams {
  symbol: string;
  prec?: string;
  key?: string;
}

class BfxApi {
  private apiKey: string;
  private apiSecret: string;
  private url: string;

  private log: voidFunction;
  private debug: voidFunction;
  private error: voidFunction;
  private logger: Console;

  private paused: boolean;
  private resumeStack: ActionsStack;
  private pingCounter: number;

  private expectations: Expectations;
  private ws: WebSocket;
  private WebSocket: typeof WebSocket;

  constructor(params: IBfxApiParameters = defaultBfxApiParameters) {
    params = { ...defaultBfxApiParameters, ...params };
    this.apiKey = params.apiKey;
    this.apiSecret = params.apiSecret;
    this.url = params.url;
    this.WebSocket = params.WebSocket || WebSocket;

    this.logger = params.logger;
    this.log = this.logger.log;
    this.debug = this.logger.debug || this.log;
    this.error = this.logger.error || this.log;

    this.paused = true;
    this.resumeStack = new ActionsStack();
    this.pingCounter = 0;

    this.expectations = new Expectations();

    this.auth = this.auth.bind(this);
    this.close = this.close.bind(this);
    this.connect = this.connect.bind(this);
    this.ping = this.ping.bind(this);
    this.restart = this.restart.bind(this);
  }

  public connect() {
    this.debug('connect');
    this.expectations.once(
      (msg) => msg.event === 'info' && msg.version,
      (msg) => {
        this.debug('msg.version', msg.version);
        if (allowedVersions.indexOf(msg.version) === -1) {
          this.error('unexpected version', msg.version);
          this.error('closing socket');
          this.ws.close();
        }
      },
    );

    this.ws = new this.WebSocket(this.url);
    this.ws.onmessage = this.handleMessage.bind(this);
    this.ws.onopen = this.resume.bind(this);
  }

  public close() {
    this.log('closing socket');
    this.ws.close();
  }

  public auth() {
    this.log('auth not implemented');
  }

  public subscribeTicker(pair: string, callback: SnapshotCallback) {
    return this.subscribe('ticker', pair, { symbol: 't' + pair }, callback);
  }

  public subscribeFTicker(pair: string, callback: SnapshotCallback) {
    return this.subscribe('fticker', pair, { symbol: 'f' + pair }, callback);
  }

  public subscribeTrades(pair: string, callback: SnapshotCallback) {
    return this.subscribe('trades', pair, { symbol: 't' + pair }, callback);
  }

  public subscribeFTrades(pair: string, callback: SnapshotCallback) {
    return this.subscribe('trades', pair, { symbol: 'f' + pair }, callback);
  }

  public subscribeBooks(pair: string, callback: SnapshotCallback) {
    return this.subscribe('book', pair, { symbol: 't' + pair }, callback);
  }

  public subscribeRawBooks(pair: string, callback: SnapshotCallback) {
    return this.subscribe('book', pair, { symbol: 't' + pair, prec: 'R0' }, callback);
  }

  public subscribeCandles(pair: string, callback: SnapshotCallback, timeFrame = '1m') {
    return this.subscribe('candles', pair, { symbol: '', key: `trade:${timeFrame}:t${pair}` }, callback);
  }

  public ping() {
    const cid = ++this.pingCounter;
    this.expectations.once((msg) => msg.event === 'pong' && msg.cid === cid, ({ ts }) => {
      this.log('proper ping/pong, ts is', ts);
    });
    this.send({ cid, event: 'ping' });
  }

  public unsubscribe(chanId: number) {
    const event = 'unsubscribe';
    this.send({ event, chanId });

    return new Promise<IUnsubscribeEvent>((resolve) => {
      this.expectations.once(
        (msg) => msg.event === 'unsubscribed' && msg.chanId === chanId,
        (msg) => resolve(msg),
      );
    });
  }

  private handleMessage(rawMsg: MessageEvent) {
    const msg = JSON.parse(rawMsg.data);

    if (this.expectations.exec(msg)) {
      return;
    }

    if (msg.event === 'info') {
      this.processMsgInfo(msg);
      return;
    }

    this.debug('unprocessed message', msg);
  }

  private processMsgInfo(msg: IMsgInfo) {
    this.debug('info message', msg);

    switch (msg.code) {
      case 20051:
        this.restart();
        break;
      case 20060:
        this.pause();
        break;
      case 20061:
        this.resume();
        break;
      default:
        this.log('unknown info message code', msg.code);
    }
  }

  private pause() {
    this.debug('pause');
    this.paused = true;
  }

  private resume() {
    this.debug('resume');
    this.paused = false;
    this.resumeStack.fire();
  }

  private restart() {
    this.debug('restart');
    this.close();
    this.connect();
  }

  private send(data: object | string) {
    if (this.paused || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.resumeStack.add(this.send.bind(this, data));
      return;
    }
    if (typeof data !== 'string') {
      data = JSON.stringify(data);
    }
    this.ws.send(data);
  }

  private subscribe(
    channel: string, pair: string, params: ISubscribeParams, callback: SnapshotCallback,
  ): Promise<ISubscribeEvent> {
    return new Promise((resolve, reject) => {
      if (typeof callback !== 'function') {
        reject(new TypeError('BfxApi.subscribe error: callback must be a function'));
        return;
      }

      const heartbeating = ([chanId]: [number]) => this.debug('Heartbeating', {chanId});

      this.expectations.once(
        (msg) => msg.event === 'subscribed' && msg.pair && msg.pair === pair,
        (e: ISubscribeEvent) => {
          this.expectations.whenever(MatchSnapshot(e.chanId), (msg) => callback(msg));
          this.expectations.whenever(MatchHeartbeat(e.chanId), heartbeating);
          resolve(e);
        },
      );
      this.send({ event: 'subscribe', channel, ...params });
    });
  }
}

export default BfxApi;
