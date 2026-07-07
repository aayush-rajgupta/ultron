import nodemailer from 'nodemailer';

export async function sendEmergencyEmail(
  senderName: string,
  senderNumber: string,
  messageHistory: { role: string; content: string }[]
): Promise<void> {
  const smtpEmail = process.env.SMTP_EMAIL;
  const smtpPassword = process.env.SMTP_PASSWORD;

  if (!smtpEmail || !smtpPassword) {
    console.error('[EMAIL] Missing SMTP credentials. Cannot send emergency email.');
    return;
  }

  // Create transporter for Gmail
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpEmail,
      pass: smtpPassword,
    },
  });

  const formattedHistory = messageHistory
    .map((msg) => `[${msg.role.toUpperCase()}]: ${msg.content}`)
    .join('\n');

  const mailOptions = {
    from: smtpEmail,
    to: smtpEmail,
    subject: `🚨 URGENT WHATSAPP EMERGENCY from ${senderName}`,
    text: `Emergency Override Triggered on WhatsApp.\n\n` +
          `Sender Name: ${senderName}\n` +
          `Sender Number: ${senderNumber}\n\n` +
          `Recent Chat History:\n` +
          `-----------------------------------\n` +
          `${formattedHistory || '[No History Available]'}\n` +
          `-----------------------------------\n`,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[EMAIL] Emergency alert email sent successfully to ${smtpEmail}`);
  } catch (error) {
    console.error('[EMAIL] Failed to send emergency email:', error);
  }
}
