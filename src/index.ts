// =============== 0. 辅助类型和枚举 ===============

import {
  type AggregationMethod,
  getAverageAggregate,
  getProductAggregate,
  getWeightedAverageAggregate,
  MIN_SCORE,
} from './aggregators';
import { GameMap } from './gameMap';

/**
 * 全局目标类型枚举
 */
export enum GlobalGoalType {
  CAPTURE_POINT = 'CAPTURE_POINT',       // 占领特定位置
  ELIMINATE_ALL_ENEMIES = 'ELIMINATE_ALL_ENEMIES', // 消灭所有敌人
  DEFEND_POINT = 'DEFEND_POINT',         // 防守特定位置
  SURVIVE_TURNS = 'SURVIVE_TURNS',       // 生存指定回合数
}

/**
 * 全局目标对象接口
 */
export interface GlobalObjective {
  type: GlobalGoalType; // 目标类型
  targetPosition?: Position; // 目标位置 (例如，占领/防守点)
  remainingTurns?: number; // 剩余回合数 (例如，生存目标)
  priority: number; // 目标优先级 (0.0 - 1.0)，用于多目标时的权衡
  id?: string; // 唯一ID，方便管理
}

/**
 * Agent状态快照接口，用于模拟
 */
export interface IAgentState {
  id: string;
  health: number;
  mana: number;
  position: Position;
  // 根据需要，可以添加更多用于模拟的状态属性
}

export interface Position {
  x: number;
  y: number;
}

export type PartialExcept<T, K extends keyof T> = Pick<T, K> & { [P in Exclude<keyof T, K>]?: T[P] }

// =============== 1. 核心接口 ===============

/**
 * 游戏代理（角色）接口
 */
export interface IAgent {
  // 基本属性
  id: string;
  health: number;
  mana: number;
  position: Position;
  teamId: string;
  movementRange: number; // 每回合最大移动范围/点数

  // 感知与状态
  visibleEnemies: IAgent[];
  visibleAllies: IAgent[];
  currentTarget: IAgent | null; // AI可能设置的当前关注目标
  teamBlackboard: TeamBlackboard; // 所属队伍的黑板，用于共享信息
  currentTurn: number; // 当前游戏回合数

  // 日志与辅助方法
  log: (message: string) => void;
  getDistanceToAgent: (gameMap: GameMap, otherAgent: IAgent | IAgentState) => number; // 计算与另一Agent或状态的距离
  canSeeAgent: (gameMap: GameMap, otherAgent: IAgent | IAgentState, fromPosition?: Position) => boolean; // 视线检查

  // 实际执行的动作 (在AI决策做出后，由游戏逻辑调用)
  performMove: (context: ActionContext, newPosition: Position) => void;
  performAttack: (target: IAgent) => void;
  performSkillOnTarget: (skillId: string, target: IAgent) => void;
  performSelfSkill: (skillId: string) => void;
  performIdle: () => void;

  // 技能与状态检查
  isSkillReady: (skillId: string) => boolean;

  getTargetDebuffs(target: IAgent): Array<{ type: string; remainingTurns: number; sourceSkill: string }>; // 获取目标身上的debuff

  // 模拟相关方法 (getSimulatedStateAfterMove might still be useful for some advanced considerations)
  getSimulatedStateAfterMove(newPosition: Position): IAgentState;

  getReachableMovePositions(map: GameMap): Position[]; // 获取所有可达的移动位置
}

/**
 * 行为上下文接口，在为行为评分时传递给考量因素
 */
export interface ActionContext {
  agent: IAgent; // 执行行为的代理（或其模拟状态）
  gameMap: GameMap; // 方便动作和考量因素访问地图信息
  potentialTarget?: IAgentState; // 行为的潜在目标（或其模拟状态）
  skillId?: string;           // 涉及的技能ID（如果适用）
  destination?: { x: number, y: number }; // 潜在的目的地 (used by MoveAction)
  // 可以根据需要添加其他上下文数据，例如当前回合数 (虽然通常从agent获取)
}

/**
 * 考量因素 (Consideration) 接口
 */
export interface IConsideration {
  readonly name: string; // 考量因素的名称，便于调试
  score(context: ActionContext): number; // 计算得分 (0-1)
}

/**
 * 效用行为 (Utility Action) 接口
 */
export interface IUtilityAction {
  readonly name: string;
  considerations: IConsideration[];
  aggregationMethod: AggregationMethod; // 分数聚合方法

  calculateUtility(agent: IAgent, baseContext?: PartialExcept<ActionContext, 'gameMap'>, debug?: boolean): number; // 计算总效用分
  canExecute(agent: IAgent, context?: ActionContext): boolean; // 是否可执行
  execute(realAgent: IAgent, context: ActionContext): void; // 注意：执行时使用真实的Agent对象
  generateContexts?(agent: IAgent, gameMap: GameMap): ActionContext[]; // 生成多个执行上下文
}


// =============== 2. 团队黑板 (信息共享) ===============
export class TeamBlackboard {
  private data: Map<string, any> = new Map();
  private currentObjectives: GlobalObjective[] = []; // 支持多个目标，按优先级排序

  public setFocusTarget(targetId: string | null): void {
    if (targetId) {
      this.data.set('teamFocusTargetId', targetId);
      console.log(`[团队黑板]: 新的集火目标 ${targetId}`);
    } else {
      this.data.delete('teamFocusTargetId');
      console.log(`[团队黑板]: 取消集火目标`);
    }
  }

  public getFocusTargetId(): string | undefined {
    return this.data.get('teamFocusTargetId');
  }

  public setTargetDebuff(targetId: string, debuffType: string, sourceSkill: string, durationTurns: number, currentTurn: number): void {
    const key = `debuff_${targetId}_${debuffType}`;
    this.data.set(key, {
      sourceSkill,
      appliedTurn: currentTurn,
      expiresTurn: currentTurn + durationTurns - 1 // 如果持续1回合，则在当前回合结束时就没了
    });
    console.log(`[团队黑板]: 目标 ${targetId} 获得debuff "${debuffType}" (来自: ${sourceSkill}, 持续到回合结束: ${currentTurn + durationTurns - 1})`);
  }

  public getTargetDebuffInfo(targetId: string, debuffType: string, currentTurn: number): {
    sourceSkill: string,
    appliedTurn: number,
    expiresTurn: number
  } | undefined {
    const key = `debuff_${targetId}_${debuffType}`;
    const debuffInfo = this.data.get(key);
    if (debuffInfo && debuffInfo.expiresTurn >= currentTurn) {
      return debuffInfo;
    }
    this.data.delete(key); // 过期则清除
    return undefined;
  }

  public addObjective(objective: GlobalObjective): void {
    // 避免重复添加相同ID的目标，如果需要更新则先移除
    if (objective.id) {
      this.removeObjective(objective.id);
    }
    this.currentObjectives.push(objective);
    this.currentObjectives.sort((a, b) => b.priority - a.priority); // 按优先级降序排序
    console.log(`[团队黑板]: 添加全局目标 "${objective.type}" (优先级: ${objective.priority})`);
  }

  public removeObjective(objectiveId: string): void {
    this.currentObjectives = this.currentObjectives.filter(obj => obj.id !== objectiveId);
  }

  public getHighestPriorityObjective(): GlobalObjective | null {
    return this.currentObjectives.length > 0 ? this.currentObjectives[0] : null;
  }

  public getAllObjectives(): GlobalObjective[] {
    return [...this.currentObjectives];
  }
}


// =============== 3. 具体考量因素实现 ===============

// --- 通用考量因素 ---
export class HealthConsideration implements IConsideration {
  name = '生命值考量';

  constructor(private isSelf: boolean, private isLowBetter: boolean, private maxHealth: number = 100) {
  }

  score(context: ActionContext): number {
    const subject = this.isSelf ? context.agent : context.potentialTarget;
    if (!subject) return 0;
    const healthRatio = Math.max(0, subject.health) / this.maxHealth;
    return this.isLowBetter ? (1 - healthRatio) : healthRatio;
  }
}

export class ManaConsideration implements IConsideration {
  name = '法力值考量';

  constructor(private requiredMana: number) {
  }

  score(context: ActionContext): number {
    return context.agent.mana >= this.requiredMana ? 1.0 : 0.0;
  }
}

export class DistanceConsideration implements IConsideration {
  name = '距离考量';

  constructor(private idealDistance: number, private maxRelevantDistance: number) {
  }

  score(context: ActionContext): number {
    // This consideration now assumes the agent is at context.agent.position
    // and the target is context.potentialTarget.position.
    // For MoveAction, we'll need considerations that evaluate context.destination.
    if (!context.potentialTarget) return 0;
    const agentPos = context.agent.position;
    const targetPos = context.potentialTarget.position;
    const dx = agentPos.x - targetPos.x;
    const dy = agentPos.y - targetPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > this.maxRelevantDistance) {
      return 0;
    }
    if (dist < 0.1 && this.idealDistance < 0.1) {
      return 1.0;
    } // 已经在理想位置（例如自身）

    const score = 1 - (Math.abs(dist - this.idealDistance) / this.maxRelevantDistance);
    return Math.max(0, Math.min(1, score));
  }
}

export class SkillReadyConsideration implements IConsideration {
  name = '技能就绪考量';

  constructor(private skillId: string) {
  }

  score(context: ActionContext): number {
    if ('isSkillReady' in context.agent && typeof context.agent.isSkillReady === 'function') {
      return context.agent.isSkillReady(this.skillId) ? 1.0 : 0.0;
    }
    return 0;
  }
}

// --- 协同考量因素 ---
export class IsTeamFocusTargetConsideration implements IConsideration {
  name = '是否团队集火目标';

  constructor(private weightIfFocusTarget: number = 1.0, private weightIfNotFocusTarget: number = 0.1) {
  }

  score(context: ActionContext): number {
    if (!('teamBlackboard' in context.agent)) return this.weightIfNotFocusTarget;

    const focusTargetId = context.agent.teamBlackboard.getFocusTargetId();
    if (focusTargetId && context.potentialTarget && context.potentialTarget.id === focusTargetId) {
      return this.weightIfFocusTarget;
    }
    return this.weightIfNotFocusTarget;
  }
}

export class TargetUnderAttackConsideration implements IConsideration { // Simplified: just low health
  name = '目标是否低血量(暗示被集火)';

  score(context: ActionContext): number {
    if (!context.potentialTarget) return 0;
    const healthRatio = Math.max(0, context.potentialTarget.health) / 100; // 假设最大生命100
    // Higher score for lower health
    return 1 - healthRatio;
  }
}

export class TargetHasSetupDebuffConsideration implements IConsideration {
  name = '目标是否有特定准备Debuff';

  constructor(private requiredDebuffType: string, private scoreIfPresent: number = 1.0, private minRemainingTurns: number = 0) {
  }

  score(context: ActionContext): number {
    if (!context.potentialTarget || !('teamBlackboard' in context.agent) || !('currentTurn' in context.agent)) return 0.05;

    const debuffInfo = context.agent.teamBlackboard.getTargetDebuffInfo(
      context.potentialTarget.id,
      this.requiredDebuffType,
      context.agent.currentTurn
    );
    if (debuffInfo && (debuffInfo.expiresTurn - context.agent.currentTurn) >= this.minRemainingTurns) {
      return this.scoreIfPresent;
    }
    return 0.05;
  }
}

// --- 全局目标考量因素 (Original, for actions from a position) ---
export class ProximityToGoalPositionConsideration implements IConsideration {
  name = '与目标点接近度 (当前位置)';
  private goalPosition: { x: number; y: number } | undefined;
  private readonly maxDistance: number;
  private readonly objectiveType: GlobalGoalType;


  constructor(objectiveType: GlobalGoalType, maxDistance: number = 20) {
    this.objectiveType = objectiveType;
    this.maxDistance = maxDistance;
  }

  score(context: ActionContext): number {
    const objective = context.agent.teamBlackboard.getHighestPriorityObjective();
    if (!objective || objective.type !== this.objectiveType || !objective.targetPosition) {
      return 0.1; // No relevant objective or objective has no position
    }
    this.goalPosition = objective.targetPosition;

    const agentPos = context.agent.position; // Current agent position
    const dx = agentPos.x - this.goalPosition.x;
    const dy = agentPos.y - this.goalPosition.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > this.maxDistance) return 0;
    if (distance < 0.5) return 1.0;
    const score = 1 - (distance / this.maxDistance);
    return Math.max(0, score);
  }
}

export class ClearDefendersAtGoalConsideration implements IConsideration {
  name = '清理目标点防守者';
  private goalPosition: { x: number; y: number } | undefined;
  private readonly clearanceRadius: number;
  private readonly objectiveType: GlobalGoalType;

  constructor(objectiveType: GlobalGoalType, clearanceRadius: number = 3) {
    this.objectiveType = objectiveType;
    this.clearanceRadius = clearanceRadius;
  }

  score(context: ActionContext): number {
    if (!context.potentialTarget || !context.potentialTarget.position) {
      return 0;
    }

    const objective = context.agent.teamBlackboard.getHighestPriorityObjective();
    if (!objective || objective.type !== this.objectiveType || !objective.targetPosition) {
      return 0.05; // No relevant objective
    }
    this.goalPosition = objective.targetPosition;

    const targetPos = context.potentialTarget.position;
    const dx = targetPos.x - this.goalPosition.x;
    const dy = targetPos.y - this.goalPosition.y;
    const distanceToGoal = Math.sqrt(dx * dx + dy * dy);

    if (distanceToGoal <= this.clearanceRadius) {
      // Score higher if attacking an enemy near the goal
      const healthRatio = Math.max(0, context.potentialTarget.health) / 100;
      return (1 - healthRatio) * 0.8; // Higher score for lower health enemy near goal
    }
    return 0.1; // Target is not near goal
  }
}


// --- NEW: Movement-specific Considerations (evaluate context.destination) ---

export class DestinationProximityToObjectiveConsideration implements IConsideration {
  name = '移动目的地与目标点接近度';

  constructor(private objectiveType: GlobalGoalType, private maxDistance: number = 20, private noObjectiveScore: number = 0.1) {
  }

  score(context: ActionContext): number {
    if (!context.destination) return 0; // This consideration is for MoveAction

    const objective = context.agent.teamBlackboard.getHighestPriorityObjective();
    if (!objective || objective.type !== this.objectiveType || !objective.targetPosition) {
      return this.noObjectiveScore; // No relevant objective or objective has no position
    }
    const goalPosition = objective.targetPosition;
    const distance = context.gameMap.getRealDistance(context.destination.x, context.destination.y, goalPosition.x, goalPosition.y);

    if (distance > this.maxDistance) {
      return 0;
    }
    // Already at the goal or very close
    if (distance < 0.5) {
      return 1.0;
    }
    return Math.max(0, 1 - (distance / this.maxDistance));
  }
}

export class DestinationSafetyConsideration implements IConsideration {
  name = '移动目的地安全度';

  constructor(private maxThreatDistance: number = 5) {
  } // Consider enemies within this range of destination

  score(context: ActionContext): number {
    if (!context.destination || !('visibleEnemies' in context.agent)) return 0.5; // Neutral if no destination or no enemy info

    const visibleEnemies = context.agent.visibleEnemies as IAgent[];
    if (visibleEnemies.length === 0) return 1.0; // Perfectly safe if no enemies visible

    let threatScore = 0;
    let enemiesNearDestination = 0;

    for (const enemy of visibleEnemies) {
      const dx = context.destination.x - enemy.position.x;
      const dy = context.destination.y - enemy.position.y;
      const distToEnemy = Math.sqrt(dx * dx + dy * dy);

      if (distToEnemy < this.maxThreatDistance) {
        threatScore += (1 - distToEnemy / this.maxThreatDistance) * (enemy.health > 0 ? 1 : 0.1); // Higher threat if closer and alive
        enemiesNearDestination++;
      }
    }

    if (enemiesNearDestination === 0) return 1.0; // Safe if no enemies near destination

    // Normalize threat score (simplistic normalization)
    const maxPossibleThreat = enemiesNearDestination; // Assuming each enemy can contribute max 1 to threatScore
    return Math.max(0, 1 - (threatScore / (maxPossibleThreat + 0.01))); // Higher score for lower threat
  }
}

export class DestinationChaseFocusTargetConsideration implements IConsideration {
  name = '移动目的地追击集火目标';

  constructor(private maxChaseDistance: number = 10) {
  }

  score(context: ActionContext): number {
    if (!context.destination || !('teamBlackboard' in context.agent) || !('visibleEnemies' in context.agent)) return 0;

    const focusTargetId = context.agent.teamBlackboard.getFocusTargetId();
    if (!focusTargetId) return 0.1; // No focus target, low baseline

    const focusTarget = (context.agent.visibleEnemies).find(e => e.id === focusTargetId);
    if (!focusTarget) {
      return 0.05;
    } // Focus target not visible

    const currentDistToTarget = context.agent.getDistanceToAgent(context.gameMap, focusTarget);
    const destPos = context.destination;
    const newDistToTarget = context.gameMap.getRealDistance(destPos.x, destPos.y, focusTarget.position.x, focusTarget.position.y);

    if (newDistToTarget >= currentDistToTarget && newDistToTarget > 1) { // If not getting closer (and not already on top)
      // Penalize if moving away or staying same distance unless very close
      return 0;
    }
    if (newDistToTarget < 0.5) return 1.0; // Will be on top of target

    const distanceReduction = currentDistToTarget - newDistToTarget;
    if (distanceReduction <= 0) return 0.1; // Did not get closer

    // Score based on how much closer we get, relative to agent's typical engagement range or maxChaseDistance
    return Math.max(0, Math.min(1, distanceReduction / (context.agent.movementRange + 0.1)));
  }
}

export class StayPutConsideration implements IConsideration {
  name = '原地不动奖励';

  constructor(private bonusIfStaying: number = 0.2) {
  } // Value of staying put

  score(context: ActionContext): number {
    if (!context.destination) return 0;
    if (context.destination.x === context.agent.position.x && context.destination.y === context.agent.position.y) {
      return this.bonusIfStaying;
    }
    return 0;
  }
}


// =============== 4. 基础效用行为类 ===============
export abstract class BaseUtilityAction implements IUtilityAction {
  abstract name: string;
  considerations: IConsideration[];
  aggregationMethod: AggregationMethod;

  protected constructor(
    considerations: IConsideration[],
    aggregationMethod: AggregationMethod = getAverageAggregate(),
  ) {
    this.considerations = considerations;
    this.aggregationMethod = aggregationMethod;
  }

  calculateUtility(agent: IAgent, baseContext?: PartialExcept<ActionContext, 'gameMap'>, debug?: boolean): number {
    // For most actions, context.agent is the one at current position.
    // For MoveAction, its considerations will use context.destination.
    const context: ActionContext = {
      agent: agent, // The real agent
      gameMap: baseContext.gameMap,
      ...baseContext
    };

    const considerationNameAndScores = this.considerations.map(c => ({ name: c.name, score: c.score(context) }));
    const aggregationScore = this.aggregationMethod(considerationNameAndScores.map(c => c.score));
    if (debug) {
      console.log(considerationNameAndScores);
      console.log(`[${this.name}] 效用总分：`, aggregationScore);
    }
    return aggregationScore;
  }

  abstract canExecute(agent: IAgent, context: ActionContext): boolean;

  abstract execute(realAgent: IAgent, context: ActionContext): void;

  generateContexts?(agent: IAgent, gameMap: GameMap): ActionContext[];
}


// =============== 5. 具体行为实现 ===============

// --- NEW: MoveAction ---
export class MoveAction extends BaseUtilityAction {
  name = '战略移动';

  constructor() {
    super(
      [
        new DestinationProximityToObjectiveConsideration(GlobalGoalType.CAPTURE_POINT, 20, 0.05), // Score 0.05 if no capture point objective
        new DestinationSafetyConsideration(6),
        new DestinationChaseFocusTargetConsideration(10),
        new StayPutConsideration(0.1), // Small bonus for staying put if other scores are low
      ],
      // Example: Prioritize safety, then goal, then chase. Staying put is a fallback.
      getWeightedAverageAggregate([0.4, 0.3, 0.25, 0.05])
    );
  }

  canExecute(agent: IAgent, context: ActionContext): boolean {
    return !!context?.destination && ('performMove' in agent);
  }

  execute(realAgent: IAgent, context: ActionContext): void {
    if (context.destination) {
      if (context.destination.x === realAgent.position.x && context.destination.y === realAgent.position.y) {
        realAgent.log(`执行 ${this.name}: 决定保持当前位置 (${context.destination.x},${context.destination.y}).`);
        // Technically no need to call performMove, but can be a no-op or a specific "hold position" log
        // realAgent.performIdle(); // Or just do nothing if move is to same spot
      } else {
        realAgent.log(`执行 ${this.name}: 移动至 (${context.destination.x},${context.destination.y}).`);
        realAgent.performMove(context, context.destination);
      }
    } else {
      realAgent.log(`${this.name} 错误: 执行时无有效目的地。`);
      realAgent.performIdle();
    }
  }

  generateContexts(agent: IAgent | IAgentState, gameMap: GameMap): ActionContext[] {
    if (!('getReachableMovePositions' in agent) || typeof agent.getReachableMovePositions !== 'function') {
      console.warn(`[${this.name}] Agent ${agent.id} does not have getReachableMovePositions method.`);
      return [];
    }

    const reachablePositions = agent.getReachableMovePositions(gameMap);
    const contexts: ActionContext[] = [];

    for (const pos of reachablePositions) {
      contexts.push({
        agent: agent, // Agent is at its current position, evaluating 'pos' as a destination
        destination: pos,
        gameMap: gameMap,
      });
    }
    // Ensure "staying put" is always an option, even if getReachableMovePositions might exclude it
    // (though the provided implementation includes it).
    // If not already present, add it.
    const alreadyHasCurrentPos = reachablePositions.some(p => p.x === agent.position.x && p.y === agent.position.y);
    if (!alreadyHasCurrentPos) {
      contexts.push({
        agent: agent,
        destination: { ...agent.position },
        gameMap: gameMap,
      });
    }
    return contexts;
  }
}


export class AttackEnemyAction extends BaseUtilityAction {
  name = '攻击敌人';

  constructor() {
    super(
      [
        new HealthConsideration(false, true), // Target low health is better
        new DistanceConsideration(1, 5),    // Ideal distance 1, max relevant 5 (for current position)
        new IsTeamFocusTargetConsideration(1.0, 0.2),
        new TargetUnderAttackConsideration(), // Target already low health (implies focus)
        // new ClearDefendersAtGoalConsideration(GlobalGoalType.CAPTURE_POINT, 5) // If attacking enemy near goal
      ],
      getWeightedAverageAggregate([0.4, 0.3, 0.2, 0.1]) // Adjusted weights
    );
  }

  canExecute(agent: IAgent, context: ActionContext): boolean {
    // Target must be visible and within a reasonable engagement range from current position
    if (!context?.potentialTarget) {
      return false;
    }
    if ('canSeeAgent' in agent && typeof agent.canSeeAgent === 'function') {
      if (!agent.canSeeAgent(context.gameMap, context.potentialTarget)) return false;
    }
    // Add a basic range check for attack action itself
    const dist = agent.getDistanceToAgent(context.gameMap, context.potentialTarget);
    return dist <= (agent.movementRange * 1.5); // Example: Attack range is 1.5x movement range
  }

  execute(realAgent: IAgent, context: ActionContext): void {
    if (!context.potentialTarget || !('id' in context.potentialTarget)) {
      realAgent.log('攻击错误: 无效的攻击目标。');
      return;
    }
    // Find the actual target from the real agent's perspective
    const actualTarget = realAgent.visibleEnemies.find(e => e.id === context.potentialTarget!.id) ||
      realAgent.visibleAllies.find(a => a.id === context.potentialTarget!.id); // Should not happen for enemies

    if (actualTarget) {
      realAgent.performAttack(actualTarget);
    } else {
      realAgent.log(`攻击错误: 找不到ID为 ${context.potentialTarget.id} 的真实目标或目标已不可见/不在攻击范围内。`);
      realAgent.performIdle(); // Fallback if target is gone
    }
  }

  generateContexts(agent: IAgent, gameMap: GameMap): ActionContext[] {
    const enemies = 'visibleEnemies' in agent ? agent.visibleEnemies as IAgent[] : [];
    return enemies
    .filter(enemy => { // Pre-filter for basic attackability from current position
      if ('canSeeAgent' in agent && typeof agent.canSeeAgent === 'function') {
        if (!agent.canSeeAgent(gameMap, enemy)) {
          return false;
        }
      }
      const dist = agent.getDistanceToAgent(gameMap, enemy);
      return dist <= (agent.movementRange * 1.5 + agent.movementRange); // Consider enemies slightly further for utility calc, canExecute will do final check
    })
    .map(enemy => ({
      agent,
      potentialTarget: enemy,
      currentTurn: 'currentTurn' in agent ? agent.currentTurn : 0,
      gameMap: gameMap
    }));
  }
}

export class HealSelfAction extends BaseUtilityAction {
  name = '治疗自己';
  private skillId = 'HealSelf'; // Example skill ID

  constructor() {
    super(
      [
        new HealthConsideration(true, true, 100), // Self, low health is better
        new SkillReadyConsideration('HealSelf'),
        new ManaConsideration(10) // Mana cost for HealSelf
      ],
      getProductAggregate() // All conditions should ideally be met
    );
  }

  canExecute(agent: IAgent, _: ActionContext): boolean {
    // Agent must have the skill, enough mana, and not be at full health (optional)
    return 'isSkillReady' in agent && agent.isSkillReady(this.skillId) && agent.mana >= 10 && agent.health < 100;
  }

  execute(realAgent: IAgent, _: ActionContext): void {
    realAgent.performSelfSkill(this.skillId);
  }

  // No generateContexts needed, applies to self
}

export class FleeAction extends BaseUtilityAction {
  name = '逃跑'; // This remains a dedicated "panic" flee, separate from strategic MoveAction

  constructor() {
    super(
      [
        new HealthConsideration(true, true, 100), // Agent's own health, lower is better (motivates fleeing)
        // Add a consideration for "number of nearby enemies" or "threat level at current position"
      ],
      getAverageAggregate()
    );
  }

  canExecute(agent: IAgent, _: ActionContext) {
    // Flee is usually possible if health is low, or many enemies nearby.
    // The FleeOverride in AIController handles the critical health case.
    // This action competes normally if FleeOverride isn't triggered.
    return agent.health < 70; // Example: consider fleeing if below 70% health
  }

  execute(realAgent: IAgent, context: ActionContext): void {
    const gameMap = context.gameMap;

    let bestFleePosition: Position | null = null;
    let maxDistFromEnemies = -1;

    const reachablePositions = realAgent.getReachableMovePositions(gameMap);

    if (realAgent.visibleEnemies.length > 0) {
      for (const pos of reachablePositions) {
        if (pos.x === realAgent.position.x && pos.y === realAgent.position.y && reachablePositions.length > 1) continue;

        let currentMinDistToEnemy = Infinity;
        for (const enemy of realAgent.visibleEnemies) {
          const dx = pos.x - enemy.position.x;
          const dy = pos.y - enemy.position.y;
          currentMinDistToEnemy = Math.min(currentMinDistToEnemy, Math.sqrt(dx * dx + dy * dy));
        }

        if (currentMinDistToEnemy > maxDistFromEnemies) {
          maxDistFromEnemies = currentMinDistToEnemy;
          bestFleePosition = pos;
        }
      }
    } else { // No visible enemies, but still chose to "Flee" (e.g. low health tactical retreat)
      // Move to a random reachable spot that isn't current location, if possible
      const safeSpots = reachablePositions.filter(p => !(p.x === realAgent.position.x && p.y === realAgent.position.y));
      if (safeSpots.length > 0) {
        bestFleePosition = safeSpots[Math.floor(Math.random() * safeSpots.length)];
      } else {
        bestFleePosition = realAgent.position; // Stay put if no other option
      }
    }

    if (bestFleePosition && (bestFleePosition.x !== realAgent.position.x || bestFleePosition.y !== realAgent.position.y)) {
      realAgent.log(`选择逃跑至 (${bestFleePosition.x},${bestFleePosition.y})！`);
      realAgent.performMove(context, bestFleePosition);
    } else {
      realAgent.log('没有明确的逃跑方向或已在安全位置，保持当前位置或警戒。');
      realAgent.performIdle();
    }
  }

  // FleeAction could also use generateContexts to choose the best flee spot,
  // making its execute simpler. For now, keeping original logic.
}


export class ApplyArmorBreakAction extends BaseUtilityAction {
  name = '使用破甲打击';
  private skillId = 'ArmorBreak';

  constructor() {
    super(
      [
        new SkillReadyConsideration('ArmorBreak'),
        new ManaConsideration(15),
        new DistanceConsideration(1, 3), // From current position
        new HealthConsideration(false, false) // Target higher health is slightly better (more value from debuff)
      ],
      getProductAggregate()
    );
  }

  canExecute(agent: IAgent, context: ActionContext): boolean {
    if (!context?.potentialTarget) return false;
    if (!('isSkillReady' in agent && agent.isSkillReady(this.skillId) && agent.mana >= 15)) return false;
    const dist = agent.getDistanceToAgent(context.gameMap, context.potentialTarget);
    return dist <= 3; // Skill range
  }

  execute(realAgent: IAgent, context: ActionContext): void {
    if (!context.potentialTarget || !('id' in context.potentialTarget)) return;
    const actualTarget = realAgent.visibleEnemies.find(e => e.id === context.potentialTarget!.id);
    if (actualTarget) {
      realAgent.performSkillOnTarget(this.skillId, actualTarget);
      realAgent.teamBlackboard.setTargetDebuff(actualTarget.id, '破甲', this.skillId, 3, realAgent.currentTurn);
    } else {
      realAgent.log(`${this.name} 错误: 目标 ${context.potentialTarget.id} 不可达或不存在。`);
    }
  }

  generateContexts(agent: IAgent, gameMap: GameMap): ActionContext[] {
    const enemies = 'visibleEnemies' in agent ? agent.visibleEnemies as IAgent[] : [];
    return enemies
    .filter(enemy => agent.getDistanceToAgent(gameMap, enemy) <= 3) // Pre-filter by skill range
    .map(enemy => ({
      agent,
      potentialTarget: enemy,
      skillId: this.skillId,
      currentTurn: 'currentTurn' in agent ? agent.currentTurn : 0,
      gameMap: gameMap
    }));
  }
}

export class ExecuteHeavyBlowAction extends BaseUtilityAction {
  name = '使用重创';
  private skillId = 'HeavyBlow';

  constructor() {
    super(
      [
        new SkillReadyConsideration('HeavyBlow'), new ManaConsideration(25),
        new DistanceConsideration(1, 2), // Short range
        new TargetHasSetupDebuffConsideration('破甲', 1.2, 0), // Bonus if target has ArmorBreak
        new HealthConsideration(false, true) // Better on low health targets
      ],
      getWeightedAverageAggregate([0.8, 0.7, 0.5, 1.2, 0.6])
    );
  }

  canExecute(agent: IAgent, context: ActionContext): boolean {
    if (!context?.potentialTarget) return false;
    if (!('isSkillReady' in agent && agent.isSkillReady(this.skillId) && agent.mana >= 25)) return false;
    const dist = agent.getDistanceToAgent(context.gameMap, context.potentialTarget);
    return dist <= 2; // Skill range
  }

  execute(realAgent: IAgent, context: ActionContext): void {
    if (!context.potentialTarget || !('id' in context.potentialTarget)) return;
    const actualTarget = realAgent.visibleEnemies.find(e => e.id === context.potentialTarget!.id);
    if (actualTarget) {
      realAgent.performSkillOnTarget(this.skillId, actualTarget);
    } else {
      realAgent.log(`${this.name} 错误: 目标 ${context.potentialTarget.id} 不可达或不存在。`);
    }
  }

  generateContexts(agent: IAgent, gameMap: GameMap): ActionContext[] {
    const enemies = 'visibleEnemies' in agent ? agent.visibleEnemies as IAgent[] : [];
    return enemies
    .filter(enemy => agent.getDistanceToAgent(gameMap, enemy) <= 2) // Pre-filter by skill range
    .map(enemy => ({
      agent,
      potentialTarget: enemy,
      skillId: this.skillId,
      currentTurn: 'currentTurn' in agent ? agent.currentTurn : 0,
      gameMap: gameMap
    }));
  }
}

export class IdleTurnAction extends BaseUtilityAction {
  name = '待命';

  constructor() {
    // Idle usually has a very low fixed utility or some minor considerations (e.g., if mana is recovering)
    super([
      // Optionally, a consideration that gives a slightly higher score if no good actions are available
      // or if waiting is strategically beneficial (e.g. mana regen, cooldowns)
    ]);
  }

  calculateUtility(agent: IAgent): number {
    // Idle should have a very low score, so it's chosen only if nothing else is better.
    // However, it should be higher than MIN_SCORE to be selectable.
    let score = 0.01;
    // if agent is very low on mana and has mana regen, idling might be slightly more valuable
    if (agent.mana < 10 && agent.health > 50) score = 0.05; // example
    return score;
  }

  canExecute() {
    return true;
  }

  execute(realAgent: IAgent, _: ActionContext): void {
    realAgent.performIdle();
  }
}


// =============== 6. AI 控制器 (Refactored) ===============
export class AIController {
  private readonly agent: IAgent;
  private readonly availableMainActions: IUtilityAction[];
  private readonly gameMap: GameMap;

  // --- AI 行为配置参数 (Simplified) ---
  // Direct influence of global goal on non-MoveAction scores
  private static readonly W_GLOBAL_GOAL_ON_ACTION_DIRECT_INFLUENCE = 0.3;

  // Flee override parameters
  private static readonly FLEE_UTILITY_THRESHOLD = 0.75; // FleeAction utility itself must be high
  private static readonly FLEE_HEALTH_RATIO_THRESHOLD = 0.35;


  constructor(agent: IAgent, mainActions: IUtilityAction[], gameMap: GameMap, private debug?: boolean) {
    this.agent = agent;
    this.availableMainActions = mainActions; // Now includes MoveAction
    this.gameMap = gameMap;
  }

  private log(message: string): void {
    this.agent.log(`[AIController] ${message}`);
  }

  private attemptFleeOverride(): boolean {
    const fleeActionInstance = this.availableMainActions.find(a => a.name === 'FleeAction') as FleeAction; // Assuming FleeAction's name
    if (fleeActionInstance) {
      const fleeContext: ActionContext = { agent: this.agent, gameMap: this.gameMap };
      if (fleeActionInstance.canExecute(this.agent, fleeContext)) {
        const fleeUtilityScore = fleeActionInstance.calculateUtility(this.agent, fleeContext, this.debug);
        const healthRatio = this.agent.health / 100;

        if (fleeUtilityScore > AIController.FLEE_UTILITY_THRESHOLD && healthRatio < AIController.FLEE_HEALTH_RATIO_THRESHOLD) {
          this.log(`紧急情况：生命值 (${(healthRatio * 100).toFixed(0)}%), 高逃跑意愿 (${fleeUtilityScore.toFixed(2)})。优先执行逃跑！`);
          fleeActionInstance.execute(this.agent, fleeContext);
          this.agent.log(`${this.agent.id} 的回合结束 (因执行逃跑覆盖)。\n`);
          return true;
        }
      }
    }
    return false;
  }

  public takeTurn(): void {
    this.log(`开始为 ${this.agent.id} 的回合决策... (当前位置: ${this.agent.position.x},${this.agent.position.y} 生命: ${this.agent.health})`);

    if (this.attemptFleeOverride()) {
      return;
    }

    let bestActionOverall: IUtilityAction | null = null;
    let bestContextOverall: ActionContext | null = null;
    let highestUtilityOverall = -Infinity;

    const currentGlobalObjective = this.agent.teamBlackboard.getHighestPriorityObjective();
    const actionUtility: { actionName: string, utility: number }[] = [];

    for (const action of this.availableMainActions) {
      let currentActionIterationUtility = -Infinity;
      let currentActionIterationContext: ActionContext | null = null;

      if (action.generateContexts) {
        const contexts = action.generateContexts(this.agent, this.gameMap);
        if (contexts.length === 0 && action.name === '战略移动') { // Special case for Move if no valid moves
          // console.log(`Agent ${this.agent.id}: MoveAction generated 0 contexts.`);
        }

        for (const generatedCtx of contexts) {
          // Context for scoring uses the real agent's current state.
          // MoveAction's considerations use generatedCtx.destination.
          // Other actions use generatedCtx.potentialTarget from current agent position.
          const contextForScoring: ActionContext = { ...generatedCtx, agent: this.agent };

          if (action.canExecute(this.agent, contextForScoring)) {
            let utility = action.calculateUtility(this.agent, contextForScoring, this.debug);

            // Apply global objective score adjustments (mainly for non-Move actions)
            if (currentGlobalObjective && action.name !== '战略移动') { // MoveAction considerations should handle goals
              if (currentGlobalObjective.type === GlobalGoalType.ELIMINATE_ALL_ENEMIES &&
                (action.name.toLowerCase().includes('attack') || action.name.toLowerCase().includes('重创') || action.name.toLowerCase().includes('破甲'))) {
                utility *= (1 + AIController.W_GLOBAL_GOAL_ON_ACTION_DIRECT_INFLUENCE * currentGlobalObjective.priority);
              }
              if (currentGlobalObjective.type === GlobalGoalType.CAPTURE_POINT && contextForScoring.potentialTarget &&
                (action.name.toLowerCase().includes('attack') || action.name.toLowerCase().includes('重创') || action.name.toLowerCase().includes('破甲'))) {
                // If attacking someone ON the point, that's good.
                const clearDefBonus = new ClearDefendersAtGoalConsideration(GlobalGoalType.CAPTURE_POINT, 5).score(contextForScoring);
                utility *= (1 + clearDefBonus * currentGlobalObjective.priority * 0.5); // Boost utility
              }
            }
            // Ensure utility is not below a minimal threshold if it's a valid action
            utility = Math.max(MIN_SCORE, utility);

            if (this.debug){
              const debugInfo = { actionName: action.name, utility };
              if (contextForScoring.destination) {
                debugInfo['destination'] = contextForScoring.destination;
              }
              actionUtility.push(debugInfo);
            }

            if (utility > currentActionIterationUtility) {
              currentActionIterationUtility = utility;
              currentActionIterationContext = contextForScoring;
            }
          }
        }
      } else { // For actions like HealSelf, Idle (which might not generate multiple contexts)
        const contextForScoring: ActionContext = { agent: this.agent, gameMap: this.gameMap };
        if (action.canExecute(this.agent, contextForScoring)) {
          currentActionIterationUtility = action.calculateUtility(this.agent, contextForScoring, this.debug);

          if (this.debug) {
            const debugInfo = { actionName: action.name, utility: currentActionIterationUtility };
            if (contextForScoring.destination) {
              debugInfo['destination'] = contextForScoring.destination;
            }
            actionUtility.push(debugInfo);
          }

          currentActionIterationContext = contextForScoring;
        }
      }

      if (currentActionIterationUtility > highestUtilityOverall) {
        highestUtilityOverall = currentActionIterationUtility;
        bestActionOverall = action;
        bestContextOverall = currentActionIterationContext;
      }
    }

    if (this.debug) {
      console.log(actionUtility);
    }

    // Fallback to Idle if no action was chosen or utility is too low
    if (!bestActionOverall || highestUtilityOverall < MIN_SCORE * 1.1) { // Check against slightly above MIN_SCORE
      const idle = this.availableMainActions.find(a => a.name === '待命');
      if (idle) {
        bestActionOverall = idle;
        bestContextOverall = { agent: this.agent, gameMap: this.gameMap };
        highestUtilityOverall = idle.calculateUtility(this.agent, bestContextOverall); // Recalc utility for idle
        this.log(`决策：无其他高价值行动，选择 "${bestActionOverall.name}" (效用: ${highestUtilityOverall.toFixed(3)})`);
      } else {
        // Absolute fallback if IdleTurnAction isn't even available
        this.log('错误：无有效行动且无待命行动，强制空闲。');
        this.agent.performIdle();
        this.agent.log(`${this.agent.id} 的回合决策结束。\n`);
        return;
      }
    }


    if (bestActionOverall && bestContextOverall) {
      this.log(`决策: 执行 "${bestActionOverall.name}"` +
        `${bestContextOverall.potentialTarget ? ` 目标: ${bestContextOverall.potentialTarget.id}` : ''}` +
        `${bestContextOverall.destination ? ` 至: (${bestContextOverall.destination.x},${bestContextOverall.destination.y})` : ''}` +
        ` (总效用 ${highestUtilityOverall.toFixed(3)})。`);

      // Ensure the execution context uses the real agent
      const executionContext: ActionContext = { ...bestContextOverall, agent: this.agent };
      bestActionOverall.execute(this.agent, executionContext);
    }
    // (Fallback to idle is handled above)
    this.agent.log(`${this.agent.id} 的回合决策结束。\n`);
  }
}


// =============== 7. 具体Agent类实现 (MyTurnBasedAgent) ===============
export class Agent implements IAgent {
  id: string;
  health: number;
  mana: number;
  position: { x: number; y: number };
  teamId: string;
  teamBlackboard: TeamBlackboard;
  currentTurn: number = 0;
  movementRange: number = 1;
  visibleEnemies: IAgent[] = [];
  visibleAllies: IAgent[] = [];
  currentTarget: IAgent | null = null;

  constructor(
    id: string, health: number, mana: number, position: Position,
    teamId: string, teamBlackboard: TeamBlackboard, movementRange: number = 3,
  ) {
    this.id = id;
    this.health = health;
    this.mana = mana;
    this.position = position;
    this.teamId = teamId;
    this.teamBlackboard = teamBlackboard;
    this.movementRange = movementRange;
  }

  log(message: string): void {
    console.log(`[${this.id} (${this.teamId})]: ${message}`);
  }

  getDistanceToAgent(gameMap: GameMap, otherAgent: IAgent): number {
    return gameMap.getRealDistance(this.position.x, this.position.y, otherAgent.position.x, otherAgent.position.y);
  }

  canSeeAgent(gameMap: GameMap, otherAgent: IAgent | IAgentState, fromPosition?: Position): boolean {
    const sourcePos = fromPosition || this.position;
    const targetPos = otherAgent.position;
    // Basic distance based visibility, Line-of-Sight would require map pathing.
    const dist = gameMap.getRealDistance(sourcePos.x, sourcePos.y, targetPos.x, targetPos.y);
    return dist < (this.movementRange * 5); // Example visibility range
  }

  performMove(context: ActionContext, position: Position): void {
    const { gameMap } = context;
    if (gameMap.isObstacle(position.x, position.y)) {
      this.log(`执行移动错误: 目标位置 (${position.x},${position.y}) 无效或为障碍物。保持原位。`);
      return;
    }
    this.log(`执行移动: 从 (${this.position.x},${this.position.y}) 到 (${position.x},${position.y})。`);
    this.position = position;
  }

  performAttack(target: IAgent): void {
    this.log(`执行攻击: 目标 ${target.id}！`);
    this.currentTarget = target; // Update current target
    // Simulate attack
    const damage = 15; // Example damage
    target.health = Math.max(0, target.health - damage);
    this.log(`${target.id} 受到 ${damage} 点伤害, 剩余生命: ${target.health}。`);
    if (target.health <= 0) this.log(`${target.id} 已被击败！`);
  }

  performSkillOnTarget(skillId: string, target: IAgent): void {
    let cost = 0;
    let damage = 0;
    if (skillId === 'ArmorBreak') {
      cost = 15;
      damage = 10;
    } else if (skillId === 'HeavyBlow') {
      cost = 25;
      damage = 30;
    }

    if (this.mana < cost) {
      this.log(`技能 "${skillId}" 失败: 法力不足.`);
      return;
    }
    this.mana -= cost;

    if (skillId === 'HeavyBlow' && this.teamBlackboard.getTargetDebuffInfo(target.id, '破甲', this.currentTurn)) {
      damage += 20; // Bonus damage for Armor Break synergy
      this.log(`对 ${target.id} 的 "重创" 触发了 "破甲" 额外伤害!`);
    }

    this.log(`执行技能: 对 ${target.id} 使用 "${skillId}"。消耗法力 ${cost}。`);
    target.health = Math.max(0, target.health - damage);
    this.log(`${target.id} 受到 ${damage} 点 "${skillId}" 伤害, 剩余生命: ${target.health}。`);
    if (target.health <= 0) {
      this.log(`${target.id} 已被击败！`);
    }
  }

  performSelfSkill(skillId: string): void {
    let cost = 0;
    let heal = 0;
    if (skillId === 'HealSelf') {
      cost = 10;
      heal = 30;
    }
    if (this.mana < cost) {
      this.log(`技能 "${skillId}" 失败: 法力不足.`);
      return;
    }
    this.mana -= cost;
    this.log(`执行技能: 对自己使用 "${skillId}"。消耗法力 ${cost}。`);
    this.health = Math.min(100, this.health + heal); // Assuming max health is 100
    this.log(`生命值恢复到 ${this.health}。`);
  }

  performIdle(): void {
    this.log('执行“待命”动作。');
  }

  isSkillReady(skillId: string): boolean {
    // Simple mana check, could involve cooldowns in a more complex system
    if (skillId === 'HealSelf') return this.mana >= 10;
    if (skillId === 'ArmorBreak') return this.mana >= 15;
    if (skillId === 'HeavyBlow') return this.mana >= 25;
    return false; // Unknown skill
  }

  getTargetDebuffs(target: IAgent): Array<{ type: string; remainingTurns: number; sourceSkill: string }> {
    const results: Array<{ type: string; remainingTurns: number; sourceSkill: string }> = [];
    const debuffTypesToCheck = ['破甲', '眩晕']; // Example debuffs
    for (const type of debuffTypesToCheck) {
      const info = this.teamBlackboard.getTargetDebuffInfo(target.id, type, this.currentTurn);
      if (info) {
        results.push({ type, remainingTurns: info.expiresTurn - this.currentTurn + 1, sourceSkill: info.sourceSkill });
      }
    }
    return results;
  }

  getSimulatedStateAfterMove(newPosition: Position): IAgentState {
    // This is primarily for other parts of the system if they need to simulate
    return { id: this.id, health: this.health, mana: this.mana, position: newPosition };
  }

  getReachableMovePositions(gameMap: GameMap): Position[] {
    const reachable: Position[] = [];
    if (!gameMap.isObstacle(this.position.x, this.position.y)) {
      reachable.push({ ...this.position }); // Current position is always "reachable" by doing nothing
    } else {
      console.warn(`Agent ${this.id} current position (${this.position.x},${this.position.y}) is invalid!`);
    }

    const queue: { pos: Position, dist: number }[] = [{ pos: this.position, dist: 0 }];
    const visited: Set<string> = new Set();
    visited.add(`${this.position.x},${this.position.y}`);

    const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]; // 8 cardinal directions

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.dist >= this.movementRange) {
        continue;
      }
      for (const [dx, dy] of DIRS) {
        const nextX = current.pos.x + dx;
        const nextY = current.pos.y + dy;
        const posKey = `${nextX},${nextY}`;

        if (!visited.has(posKey)) {
          visited.add(posKey);
          if (!gameMap.isObstacle(nextX, nextY)) {
            reachable.push({ x: nextX, y: nextY });
            queue.push({ pos: { x: nextX, y: nextY }, dist: current.dist + 1 });
          }
        }
      }
    }
    return Array.from(new Set(reachable.map(p => JSON.stringify(p)))).map(s => JSON.parse(s));
  }


  simulatePerception(allAgents: Agent[], gameMap: GameMap): void {
    // Update visible enemies and allies based on canSeeAgent and game state
    this.visibleEnemies = allAgents.filter(a =>
      a.id !== this.id && a.teamId !== this.teamId && a.health > 0 && this.canSeeAgent(gameMap, a)
    );
    this.visibleAllies = allAgents.filter(a =>
      a.id !== this.id && a.teamId === this.teamId && a.health > 0 && this.canSeeAgent(gameMap, a)
    );
  }
}