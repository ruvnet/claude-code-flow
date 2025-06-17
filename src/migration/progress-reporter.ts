/**
 * Progress Reporter - Provides visual feedback during migration
 */

import chalk from "npm:chalk@^4.1.2";
import { MigrationProgress } from './types.ts';

export class ProgressReporter {
  private progress: MigrationProgress;
  private startTime: Date;
  private spinner: string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex: number = 0;
  private intervalId: NodeJS.Timeout | null = null;

  constructor() {
    this.progress = {
      total: 0,
      completed: 0,
      current: '',
      phase: 'analyzing',
      errors: 0,
      warnings: 0
    };
    this.startTime = new Date();
  }

  start(phase: MigrationProgress['phase'], message: string): void {
    this.progress.phase = phase;
    this.progress.current = message;
    this.startTime = new Date();
    
    console.log(chalk.bold(`\n🚀 Starting ${phase}...`));
    this.startSpinner();
  }

  update(phase: MigrationProgress['phase'], message: string, completed?: number, total?: number): void {
    this.progress.phase = phase;
    this.progress.current = message;
    
    if (completed !== undefined) {
      this.progress.completed = completed;
    }
    
    if (total !== undefined) {
      this.progress.total = total;
    }
    
    this.updateDisplay();
  }

  complete(message: string): void {
    this.stopSpinner();
    
    const duration = new Date().getTime() - this.startTime.getTime();
    const seconds = (duration / 1000).toFixed(2);
    
    console.log(chalk.green(`\n✅ ${message}`));
    console.log(chalk.gray(`   Completed in ${seconds}s`));
    
    if (this.progress.warnings > 0) {
      console.log(chalk.yellow(`   ${this.progress.warnings} warnings`));
    }
    
    if (this.progress.errors > 0) {
      console.log(chalk.red(`   ${this.progress.errors} errors`));
    }
  }

  error(message: string): void {
    this.stopSpinner();
    console.log(chalk.red(`\n❌ ${message}`));
    this.progress.errors++;
  }

  warning(message: string): void {
    console.log(chalk.yellow(`⚠️  ${message}`));
    this.progress.warnings++;
  }

  info(message: string): void {
    console.log(chalk.blue(`ℹ️  ${message}`));
  }

  private startSpinner(): void {
    this.intervalId = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinner.length;
      this.updateDisplay();
    }, 100);
  }

  private stopSpinner(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Clear the spinner line
    process.stdout.write('\r\x1b[K');
  }

  private updateDisplay(): void {
    const spinner = this.spinner[this.spinnerIndex];
    const phase = this.getPhaseDisplay();
    const progress = this.getProgressDisplay();
    
    const message = `${spinner} ${phase} ${progress} ${this.progress.current}`;
    
    // Clear line and write new message
    process.stdout.write('\r\x1b[K' + message);
  }

  private getPhaseDisplay(): string {
    const phases = {
      'analyzing': chalk.blue('📊 Analyzing'),
      'backing-up': chalk.yellow('💾 Backing up'),
      'migrating': chalk.green('🔄 Migrating'),
      'validating': chalk.cyan('✅ Validating'),
      'complete': chalk.green('✅ Complete')
    };
    
    return phases[this.progress.phase] || chalk.gray('⏳ Processing');
  }

  private getProgressDisplay(): string {
    if (this.progress.total > 0) {
      const percentage = Math.round((this.progress.completed / this.progress.total) * 100);
      const progressBar = this.createProgressBar(percentage);
      return `${progressBar} ${this.progress.completed}/${this.progress.total} (${percentage}%)`;
    }
    return '';
  }

  private createProgressBar(percentage: number, width: number = 20): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    
    const filledBar = '█'.repeat(filled);
    const emptyBar = '░'.repeat(empty);
    
    return chalk.green(filledBar) + chalk.gray(emptyBar);
  }

  setTotal(total: number): void {
    this.progress.total = total;
  }

  increment(message?: string): void {
    this.progress.completed++;
    if (message) {
      this.progress.current = message;
    }
    this.updateDisplay();
  }

  getProgress(): MigrationProgress {
    return { ...this.progress };
  }
}