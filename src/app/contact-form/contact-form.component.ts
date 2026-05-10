import { Component, Input, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';

export interface ContactTranslations {
  contactNameLabel: string;
  contactEmailLabel: string;
  contactEmailError: string;
  contactPhoneLabel: string;
  contactPhoneError: string;
  contactMessageLabel: string;
  contactSend: string;
  contactSending: string;
  contactSuccess: string;
  contactError: string;
}

const WORKER_URL = 'https://imstud-contact.ivelinmat.workers.dev';

@Component({
  selector: 'app-contact-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './contact-form.component.html',
  styleUrls: ['./contact-form.component.scss'],
})
export class ContactFormComponent {
  @Input() t!: ContactTranslations;
  @ViewChild('cf') form!: NgForm;

  formData = { from_name: '', from_email: '', phone: '', message: '' };
  formStatus: 'idle' | 'sending' | 'success' | 'error' = 'idle';

  sendEmail() {
    this.formStatus = 'sending';
    fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.formData),
    }).then(res => {
      if (!res.ok) throw new Error();
      this.formStatus = 'success';
      this.form.resetForm();
    }).catch(() => {
      this.formStatus = 'error';
    });
  }
}
