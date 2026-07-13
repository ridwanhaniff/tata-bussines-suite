import { container } from 'tsyringe';
import { TOKENS } from './container';
import { RedisStateService } from '../services/state.service';
import { EventBus } from '../services/event-bus.service';
import { Logger } from '../services/logger.service';

import supabase from '../config/supabase';
import type { IStateService, IEventBus, ILogger } from '../types/interfaces';

export function registerDependencies(): void {
  container.registerSingleton<ILogger>(TOKENS.Logger, Logger);
  container.registerSingleton<IEventBus>(TOKENS.EventBus, EventBus);
  container.registerSingleton<IStateService>(TOKENS.StateService, RedisStateService);

  container.registerInstance(TOKENS.Supabase, supabase);
}
