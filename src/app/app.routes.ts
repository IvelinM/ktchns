import { Routes } from '@angular/router';
import { HomeComponent } from './home/home.component';
import { AdminPageComponent } from './admin/admin-page.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'admin', component: AdminPageComponent },
];
