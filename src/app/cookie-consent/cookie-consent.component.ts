import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface CookieConsentTranslations {
  cookieMessage: string;
  cookieAccept: string;
  cookieReject: string;
}

declare const gtag: (...args: any[]) => void;
declare const clarity: (...args: any[]) => void;

const STORAGE_KEY = 'viaminima_cookie_consent';
type ConsentChoice = 'granted' | 'denied';

@Component({
  selector: 'app-cookie-consent',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cookie-consent.component.html',
  styleUrls: ['./cookie-consent.component.scss'],
})
export class CookieConsentComponent implements OnInit {
  @Input() t!: CookieConsentTranslations;

  visible = false;

  ngOnInit() {
    const stored = localStorage.getItem(STORAGE_KEY) as ConsentChoice | null;
    if (stored === 'granted' || stored === 'denied') {
      this.applyConsent(stored);
    } else {
      this.visible = true;
    }
  }

  accept() {
    this.applyConsent('granted');
    localStorage.setItem(STORAGE_KEY, 'granted');
    this.visible = false;
  }

  reject() {
    this.applyConsent('denied');
    localStorage.setItem(STORAGE_KEY, 'denied');
    this.visible = false;
  }

  private applyConsent(choice: ConsentChoice) {
    if (typeof gtag === 'function') {
      gtag('consent', 'update', {
        ad_storage: choice,
        ad_user_data: choice,
        ad_personalization: choice,
        analytics_storage: choice,
      });
    }
    if (typeof clarity === 'function') {
      const clarityState = choice === 'granted' ? 'granted' : 'denied';
      clarity('consentv2', {
        ad_Storage: clarityState,
        analytics_Storage: clarityState,
      });
    }
  }
}
