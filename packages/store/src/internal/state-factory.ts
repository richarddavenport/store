import { Injectable, Injector, Optional, SkipSelf, Inject, OnDestroy } from '@angular/core';
import { forkJoin, from, Observable, of, throwError, Subscription } from 'rxjs';
import {
  catchError,
  defaultIfEmpty,
  filter,
  map,
  mergeMap,
  shareReplay,
  takeUntil
} from 'rxjs/operators';

import { META_KEY, NgxsConfig } from '../symbols';
import {
  buildGraph,
  findFullParentPath,
  isObject,
  MappedStore,
  MetaDataModel,
  nameToState,
  propGetter,
  StateClassInternal,
  StateKeyGraph,
  StatesAndDefaults,
  StatesByName,
  topologicalSort,
  RuntimeSelectorContext,
  SharedSelectorOptions
} from './internals';
import { getActionTypeFromInstance, getValue, setValue } from '../utils/utils';
import { ofActionDispatched } from '../operators/of-action';
import { ActionContext, ActionStatus, InternalActions } from '../actions-stream';
import { InternalDispatchedActionResults } from '../internal/dispatcher';
import { StateContextFactory } from '../internal/state-context-factory';
import { StoreValidators } from '../utils/store-validators';
import { INITIAL_STATE_TOKEN, PlainObjectOf, memoize } from '@ngxs/store/internals';

/**
 * State factory class
 * @ignore
 */
@Injectable()
export class StateFactory implements OnDestroy {
  private _actionsSubscription: Subscription | null = null;

  constructor(
    private _injector: Injector,
    private _config: NgxsConfig,
    @Optional()
    @SkipSelf()
    private _parentFactory: StateFactory,
    private _actions: InternalActions,
    private _actionResults: InternalDispatchedActionResults,
    private _stateContextFactory: StateContextFactory,
    @Optional()
    @Inject(INITIAL_STATE_TOKEN)
    private _initialState: any
  ) {}

  private _states: MappedStore[] = [];

  get states(): MappedStore[] {
    return this._parentFactory ? this._parentFactory.states : this._states;
  }

  private _statesByName: StatesByName = {};

  get statesByName(): StatesByName {
    return this._parentFactory ? this._parentFactory.statesByName : this._statesByName;
  }

  private _statePaths: PlainObjectOf<string> = {};

  private get statePaths(): PlainObjectOf<string> {
    return this._parentFactory ? this._parentFactory.statePaths : this._statePaths;
  }

  getRuntimeSelectorContext = memoize(() => {
    const stateFactory = this;
    const context: RuntimeSelectorContext = this._parentFactory
      ? this._parentFactory.getRuntimeSelectorContext()
      : {
          getStateGetter(key: string) {
            const path = stateFactory.statePaths[key];
            return path ? propGetter(path.split('.'), stateFactory._config) : () => undefined;
          },
          getSelectorOptions(localOptions?: SharedSelectorOptions) {
            const globalSelectorOptions = stateFactory._config.selectorOptions;
            return {
              ...globalSelectorOptions,
              ...(localOptions || {})
            };
          }
        };
    return context;
  });

  private static cloneDefaults(defaults: any): any {
    let value = {};

    if (Array.isArray(defaults)) {
      value = defaults.slice();
    } else if (isObject(defaults)) {
      value = { ...defaults };
    } else if (defaults === undefined) {
      value = {};
    } else {
      value = defaults;
    }

    return value;
  }

  private static checkStatesAreValid(stateClasses: StateClassInternal[]): void {
    stateClasses.forEach(StoreValidators.getValidStateMeta);
  }

  ngOnDestroy(): void {
    // I'm using non-null assertion here since `_actionsSubscrition` will
    // be 100% defined. This is because `ngOnDestroy()` cannot be invoked
    // on the `StateFactory` until its initialized :) An it's initialized
    // for the first time along with the `NgxsRootModule`.
    this._actionsSubscription!.unsubscribe();
  }

  /**
   * Add a new state to the global defs.
   */
  add(stateClasses: StateClassInternal[]): MappedStore[] {
    StateFactory.checkStatesAreValid(stateClasses);
    const { newStates } = this.addToStatesMap(stateClasses);
    if (!newStates.length) return [];

    const stateGraph: StateKeyGraph = buildGraph(newStates);
    const sortedStates: string[] = topologicalSort(stateGraph);
    const paths: PlainObjectOf<string> = findFullParentPath(stateGraph);
    const nameGraph: PlainObjectOf<StateClassInternal> = nameToState(newStates);
    const bootstrappedStores: MappedStore[] = [];

    for (const name of sortedStates) {
      const stateClass: StateClassInternal = nameGraph[name];
      const path: string = paths[name];
      const meta: MetaDataModel = stateClass[META_KEY]!;

      this.addRuntimeInfoToMeta(meta, path);

      const stateMap: MappedStore = {
        name,
        path,
        isInitialised: false,
        actions: meta.actions,
        instance: this._injector.get(stateClass),
        defaults: StateFactory.cloneDefaults(meta.defaults)
      };

      // ensure our store hasn't already been added
      // but don't throw since it could be lazy
      // loaded from different paths
      if (!this.hasBeenMountedAndBootstrapped(name, path)) {
        bootstrappedStores.push(stateMap);
      }

      this.states.push(stateMap);
    }

    return bootstrappedStores;
  }

  /**
   * Add a set of states to the store and return the defaults
   */
  addAndReturnDefaults(stateClasses: StateClassInternal[]): StatesAndDefaults {
    const classes: StateClassInternal[] = stateClasses || [];

    const mappedStores: MappedStore[] = this.add(classes);
    const defaults = mappedStores.reduce(
      (result: any, mappedStore: MappedStore) =>
        setValue(result, mappedStore.path, mappedStore.defaults),
      {}
    );
    return { defaults, states: mappedStores };
  }

  /**
   * Bind the actions to the handlers
   */
  connectActionHandlers() {
    if (this._actionsSubscription !== null) return;
    this._actionsSubscription = this._actions
      .pipe(
        filter((ctx: ActionContext) => ctx.status === ActionStatus.Dispatched),
        mergeMap(({ action }) =>
          this.invokeActions(this._actions, action!).pipe(
            map(() => <ActionContext>{ action, status: ActionStatus.Successful }),
            defaultIfEmpty(<ActionContext>{ action, status: ActionStatus.Canceled }),
            catchError(error =>
              of(<ActionContext>{ action, status: ActionStatus.Errored, error })
            )
          )
        )
      )
      .subscribe(ctx => this._actionResults.next(ctx));
  }

  /**
   * Invoke actions on the states.
   */
  invokeActions(actions$: InternalActions, action: any) {
    const type = getActionTypeFromInstance(action)!;
    const results = [];

    for (const metadata of this.states) {
      const actionMetas = metadata.actions[type];

      if (actionMetas) {
        for (const actionMeta of actionMetas) {
          const stateContext = this._stateContextFactory.createStateContext(metadata);
          try {
            let result = metadata.instance[actionMeta.fn](stateContext, action);

            if (result instanceof Promise) {
              result = from(result);
            }

            if (result instanceof Observable) {
              // If this observable has been completed w/o emitting
              // any value then we wouldn't want to complete the whole chain
              // of actions. Since if any observable completes then
              // action will be canceled.
              // For instance if any action handler would've had such statement:
              // `handler(ctx) { return EMPTY; }`
              // then the action will be canceled.
              // See https://github.com/ngxs/store/issues/1568
              result = result.pipe(defaultIfEmpty({}));

              if (actionMeta.options.cancelUncompleted) {
                // todo: ofActionDispatched should be used with action class
                result = result.pipe(
                  takeUntil(actions$.pipe(ofActionDispatched(action as any)))
                );
              }
            } else {
              result = of({}).pipe(shareReplay());
            }

            results.push(result);
          } catch (e) {
            results.push(throwError(e));
          }
        }
      }
    }

    if (!results.length) {
      results.push(of({}));
    }

    return forkJoin(results);
  }

  private addToStatesMap(
    stateClasses: StateClassInternal[]
  ): { newStates: StateClassInternal[] } {
    const newStates: StateClassInternal[] = [];
    const statesMap: StatesByName = this.statesByName;

    for (const stateClass of stateClasses) {
      const stateName: string = StoreValidators.checkStateNameIsUnique(stateClass, statesMap);
      const unmountedState = !statesMap[stateName];
      if (unmountedState) {
        newStates.push(stateClass);
        statesMap[stateName] = stateClass;
      }
    }

    return { newStates };
  }

  private addRuntimeInfoToMeta(meta: MetaDataModel, path: string): void {
    this.statePaths[meta.name!] = path;
    // TODO: v4 - we plan to get rid of the path property because it is non-deterministic
    // we can do this when we get rid of the incorrectly exposed getStoreMetadata
    // We will need to come up with an alternative in v4 because this is used by many plugins
    meta.path = path;
  }

  /**
   * @description
   * the method checks if the state has already been added to the tree
   * and completed the life cycle
   * @param name
   * @param path
   */
  private hasBeenMountedAndBootstrapped(name: string, path: string): boolean {
    const valueIsBootstrappedInInitialState: boolean =
      getValue(this._initialState, path) !== undefined;
    return this.statesByName[name] && valueIsBootstrappedInInitialState;
  }
}
