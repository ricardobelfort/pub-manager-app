import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ZardButtonComponent } from './shared/components/button/button.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ZardButtonComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly title = signal('pub-manager-app');
}
